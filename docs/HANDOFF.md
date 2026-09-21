# Handoff for Eng (Grok Bot morning routine)

You own the morning wake/routine. This repo owns two things: turning brief Markdown into printer-friendly text, and getting it onto Matt's printer via CUPS. Everything runs from one command.

## The one command

```sh
# real print
cat brief.md | python3 print_brief.py

# or from a file
python3 print_brief.py --input brief.md
```

Requirements on the host that runs it: Python 3.10+ and CUPS (`lp`/`lpstat`). macOS has CUPS built in; on Debian/Ubuntu `apt install cups-client`. No pip packages, no bun, nothing else.

**The host must be able to reach the printer** (same LAN, or a `CUPS_SERVER` that can). If your routine runs somewhere else, trigger this command on Matt's Mac / a Pi rather than running it where you are.

## Suggested routine

| When | What |
|---|---|
| 06:45 local, Mon–Fri | Assemble the brief as Markdown → pipe into `print_brief.py` |
| Any time you change the brief format | Run with `--dry-run` first and inspect `out/brief-YYYY-MM-DD.txt` |
| Once at setup | Confirm `lpstat -p "$PRINTER_NAME"` shows the queue |

Run it once per morning. If the exit code is 0, the job is in CUPS — do **not** retry, even if the printer looks idle (see failure behavior).

## Brief content

Assumption: you already produce the brief; this script only formats and prints it. Feed it Markdown on stdin or via `--input`. Supported: `#`/`##` headings, `-`/`*` bullets, numbered lists, `>` quotes, `**bold**`/`*italic*`/`` `code` `` (markers stripped), links (rendered as `text (url)`), fenced code blocks (indented verbatim), `---` rules. Tables pass through as-is. See `examples/sample-brief.md`.

Keep it under ~2 pages (roughly 120 lines at 80 columns) — CUPS paginates automatically.

## Environment variables

Copy `.env.example` to `.env` next to the script (or export them). `.env` is gitignored; never commit real values.

| Var | Required | Meaning |
|---|---|---|
| `PRINTER_NAME` | for real prints | CUPS queue name from `lpstat -p` |
| `CUPS_SERVER` | no | `host[:port]` of a remote CUPS server; `lp` honors it natively |
| `LP_OPTIONS` | no | extra `lp` flags, e.g. `-o media=Letter -o sides=one-sided` |
| `BRIEF_OUT_DIR` | no | where rendered text is written (default `out/`) |

`--printer NAME` overrides `PRINTER_NAME`; `--env-file PATH` picks a different dotenv.

### Adding the printer once

If `lpstat -p` shows nothing useful, create a queue for any IPP/AirPrint printer:

```sh
lpadmin -p daily-brief -E -v ipp://<printer-hostname-or-ip>/ipp/print -m everywhere
lpstat -p daily-brief
```

Then `PRINTER_NAME=daily-brief`.

## Failure behavior

| Situation | What happens | Exit |
|---|---|---|
| Content empty / whitespace only | Nothing is rendered or printed; stderr says so | 2 |
| `PRINTER_NAME` unset (and no `--printer`) | Text is rendered to `out/`, nothing printed | 3 |
| Queue name not known to CUPS (`lpstat -p` fails) | Nothing submitted; stderr shows the `lpadmin` hint | 3 |
| `lp` missing, errors, or hangs >30s | Nothing (or partially) submitted; stderr has `lp`'s message | 4 |
| Printer **offline / out of paper** but queue exists | `lp` succeeds and CUPS holds the job; it prints when the printer comes back | 0 |

That last row matters: a 0 exit means "queued", not "paper is out of the printer". Don't re-run on a 0 or Matt gets duplicates. To see what's pending: `lpstat -o`; to cancel: `cancel -a "$PRINTER_NAME"`.

The rendered text is always written to `out/brief-YYYY-MM-DD.txt` (even on real prints), so you can attach or re-send it if something went wrong.

## Dry run (no paper)

```sh
python3 print_brief.py --dry-run --input examples/sample-brief.md
cat out/brief-$(date +%F).txt
```

`--dry-run` never calls `lp` and doesn't need `PRINTER_NAME` or CUPS installed. Use `--out /tmp/x.txt` to pick the path.

## Not in scope (yet)

- Fetching brief content from anywhere — you provide it.
- PDF / rich typography. If wanted later, swap the renderer for `pandoc -o brief.pdf` behind the same CLI.
- A daemon or cloud print relay. Only needed if no LAN host can run the command.
