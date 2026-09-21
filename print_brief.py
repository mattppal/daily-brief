#!/usr/bin/env python3
"""Render a Markdown daily brief to printer-friendly text and send it to CUPS.

Usage:
    cat brief.md | python3 print_brief.py            # print via `lp -d $PRINTER_NAME`
    python3 print_brief.py --input brief.md --dry-run # render to out/, print nothing

Exit codes:
    0 ok            2 empty content (nothing printed)
    3 printer queue not found     4 `lp` failed or timed out
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

EXIT_EMPTY = 2
EXIT_NO_PRINTER = 3
EXIT_LP_FAILED = 4

LINE_WIDTH = 80
LP_TIMEOUT_SECONDS = 30


def load_dotenv(path: Path) -> None:
    """Minimal .env loader; never overrides variables already set in the environment."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


_INLINE_PATTERNS = [
    (re.compile(r"\*\*(.+?)\*\*"), r"\1"),
    (re.compile(r"__(.+?)__"), r"\1"),
    (re.compile(r"(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)"), r"\1"),
    (re.compile(r"(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)"), r"\1"),
    (re.compile(r"`([^`]*)`"), r"\1"),
    (re.compile(r"!\[([^\]]*)\]\([^)]*\)"), r"\1"),
    (re.compile(r"\[([^\]]+)\]\(([^)]+)\)"), r"\1 (\2)"),
]


def _inline(text: str) -> str:
    for pattern, repl in _INLINE_PATTERNS:
        text = pattern.sub(repl, text)
    return text


def render_markdown(md: str) -> str:
    """Convert a Markdown subset to plain text suited to CUPS's text filter.

    Headings become uppercase with an underline, list markers are normalised,
    emphasis/code/link syntax is stripped, and code blocks are indented verbatim.
    """
    out: list[str] = []
    in_code = False
    for raw in md.splitlines():
        line = raw.rstrip()
        if line.strip().startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            out.append("    " + line)
            continue

        heading = re.match(r"^(#{1,6})\s+(.*)$", line)
        if heading:
            level, title = len(heading.group(1)), _inline(heading.group(2)).strip()
            if level == 1:
                title = title.upper()
            underline = ("=" if level == 1 else "-") * min(len(title), LINE_WIDTH)
            if out and out[-1] != "":
                out.append("")
            out.extend([title, underline])
            continue

        if re.match(r"^\s*([-*_])(\s*\1){2,}\s*$", line):
            out.append("-" * LINE_WIDTH)
            continue

        bullet = re.match(r"^(\s*)[-*+]\s+(.*)$", line)
        if bullet:
            indent = " " * (len(bullet.group(1)) // 2 * 2)
            out.append(f"{indent}* {_inline(bullet.group(2))}")
            continue

        ordered = re.match(r"^(\s*)(\d+)[.)]\s+(.*)$", line)
        if ordered:
            indent = " " * (len(ordered.group(1)) // 2 * 2)
            out.append(f"{indent}{ordered.group(2)}. {_inline(ordered.group(3))}")
            continue

        quote = re.match(r"^\s*>\s?(.*)$", line)
        if quote:
            out.append(f"  | {_inline(quote.group(1))}")
            continue

        out.append(_inline(line))

    text = "\n".join(out).strip("\n")
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text + "\n" if text else ""


def read_source(path: str | None) -> str:
    if path and path != "-":
        return Path(path).read_text(encoding="utf-8")
    if sys.stdin.isatty():
        sys.stderr.write("print_brief: no --input given and stdin is a terminal; nothing to print\n")
        return ""
    return sys.stdin.read()


def printer_exists(printer: str) -> bool | None:
    """True/False if `lpstat` can answer; None if `lpstat` is unavailable."""
    lpstat = shutil.which("lpstat")
    if not lpstat:
        return None
    result = subprocess.run(
        [lpstat, "-p", printer], capture_output=True, text=True, timeout=LP_TIMEOUT_SECONDS
    )
    return result.returncode == 0


def send_to_printer(text_path: Path, printer: str, extra_options: str, title: str) -> int:
    lp = shutil.which("lp")
    if not lp:
        sys.stderr.write("print_brief: `lp` not found; install cups-client (Linux) or use macOS's built-in CUPS\n")
        return EXIT_LP_FAILED

    exists = printer_exists(printer)
    if exists is False:
        sys.stderr.write(
            f"print_brief: printer queue '{printer}' not found. Check `lpstat -p` or create one with "
            f"`lpadmin -p {printer} -E -v ipp://<printer-host>/ipp/print -m everywhere`\n"
        )
        return EXIT_NO_PRINTER

    cmd = [lp, "-d", printer, "-t", title, *shlex.split(extra_options), str(text_path)]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=LP_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        sys.stderr.write(f"print_brief: `lp` timed out after {LP_TIMEOUT_SECONDS}s (is CUPS running?)\n")
        return EXIT_LP_FAILED

    if result.returncode != 0:
        sys.stderr.write(f"print_brief: `lp` failed ({result.returncode}): {result.stderr.strip()}\n")
        return EXIT_LP_FAILED

    sys.stdout.write(result.stdout.strip() + "\n")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", "-i", help="Markdown file to print (default: stdin)")
    parser.add_argument("--dry-run", action="store_true", help="render to a file and print nothing")
    parser.add_argument("--out", help="output path for --dry-run (default: $BRIEF_OUT_DIR/brief-YYYY-MM-DD.txt)")
    parser.add_argument("--printer", help="CUPS queue name (default: $PRINTER_NAME)")
    parser.add_argument("--env-file", default=".env", help="dotenv file to load (default: .env)")
    args = parser.parse_args(argv)

    load_dotenv(Path(args.env_file))

    markdown = read_source(args.input)
    text = render_markdown(markdown)
    if not text.strip():
        sys.stderr.write("print_brief: brief content is empty; refusing to print a blank page\n")
        return EXIT_EMPTY

    today = dt.date.today().isoformat()
    out_dir = Path(os.environ.get("BRIEF_OUT_DIR", "out"))
    out_path = Path(args.out) if args.out else out_dir / f"brief-{today}.txt"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(text, encoding="utf-8")

    if args.dry_run:
        sys.stdout.write(f"dry-run: rendered {len(text.splitlines())} lines to {out_path}; nothing sent to printer\n")
        return 0

    printer = args.printer or os.environ.get("PRINTER_NAME", "")
    if not printer:
        sys.stderr.write("print_brief: set PRINTER_NAME (or pass --printer); run with --dry-run to skip printing\n")
        return EXIT_NO_PRINTER

    return send_to_printer(out_path, printer, os.environ.get("LP_OPTIONS", ""), f"Daily brief {today}")


if __name__ == "__main__":
    sys.exit(main())
