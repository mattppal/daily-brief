#!/usr/bin/env bun
/**
 * Render a Markdown daily brief to a minimalist one-column PDF and send it to CUPS.
 *
 * Usage:
 *   cat brief.md | bun print_brief.ts              # print via `lp -d $PRINTER_NAME`
 *   bun print_brief.ts --input brief.md --dry-run  # render to out/, print nothing
 *
 * Exit codes:
 *   0 ok            2 empty content (nothing printed)
 *   3 printer queue not found     4 `lp` failed or timed out
 *
 * Uses only `node:` built-ins so it also runs under `node --experimental-strip-types`.
 * The PDF is written by hand with the built-in Courier fonts, so the file sent to `lp`
 * prints identically on any host and can be previewed before anything hits paper.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

const EXIT_EMPTY = 2;
const EXIT_NO_PRINTER = 3;
const EXIT_LP_FAILED = 4;

const LP_TIMEOUT_MS = 30_000;

// Page layout: US Letter, 1" margins, Courier 11pt on a 15pt leading.
const PAGE = { width: 612, height: 792, margin: 72 };
const FONT_SIZE = 11;
const TITLE_SIZE = 14;
const LEADING = 15;
// Courier glyphs are 0.6em wide; keep lines comfortably inside the text block.
const LINE_WIDTH = Math.floor((PAGE.width - 2 * PAGE.margin) / (FONT_SIZE * 0.6)) - 2; // 68
const RULE_WIDTH = 24;

// Paper default for `lp`. LP_OPTIONS is appended after this, so Matt's values win
// (e.g. `-o sides=one-sided`). Margins/fonts live in the PDF, not in lp options.
const DEFAULT_LP_OPTIONS = ["-o", "media=Letter"];

const HELP = `Usage: bun print_brief.ts [--input FILE] [--dry-run] [--out PATH] [--printer QUEUE] [--env-file PATH]

  -i, --input FILE   Markdown file to print (default: stdin)
      --dry-run      render to files and print nothing
      --out PATH     PDF output path (default: $BRIEF_OUT_DIR/brief-YYYY-MM-DD.pdf);
                     a .txt with the same stem is written alongside
      --printer Q    CUPS queue name (default: $PRINTER_NAME)
      --env-file P   dotenv file to load (default: .env)
  -h, --help

Exit codes: 0 ok, 2 empty content, 3 printer queue not found, 4 lp failed/timed out
`;

/** Minimal .env loader; never overrides variables already set in the environment. */
function loadDotenv(path: string): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

// ---------------------------------------------------------------- Markdown → lines

type Style = "title" | "heading" | "body";
type Line = { text: string; style: Style };

const INLINE_PATTERNS: Array<[RegExp, string]> = [
  [/\*\*(.+?)\*\*/g, "$1"],
  [/__(.+?)__/g, "$1"],
  [/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, "$1"],
  [/(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/g, "$1"],
  [/`([^`]*)`/g, "$1"],
  [/!\[([^\]]*)\]\([^)]*\)/g, "$1"],
  [/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)"],
];

function inline(text: string): string {
  for (const [pattern, repl] of INLINE_PATTERNS) text = text.replace(pattern, repl);
  return text;
}

/** Word-wrap `text` to LINE_WIDTH; `first` prefixes line 1, `rest` the continuation lines. */
function wrap(text: string, first = "", rest = " ".repeat(first.length)): string[] {
  if (first.length + text.length <= LINE_WIDTH) return [first + text];
  const lines: string[] = [];
  let cur = first;
  let prefixLen = first.length;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (cur.length > prefixLen && cur.length + 1 + word.length > LINE_WIDTH) {
      lines.push(cur);
      cur = rest;
      prefixLen = rest.length;
    }
    cur += (cur.length > prefixLen ? " " : "") + word;
  }
  lines.push(cur);
  return lines;
}

/**
 * Convert a Markdown subset to styled plain-text lines. `#` becomes the page title and
 * `##` uppercase section headings; lists use `•` / `1.`; emphasis/code/link syntax is
 * stripped; prose is word-wrapped; fenced code blocks are indented verbatim.
 */
export function renderMarkdown(md: string): Line[] {
  const out: Line[] = [];
  let inCode = false;
  const last = () => out[out.length - 1]?.text;
  const push = (texts: string[], style: Style = "body") => {
    for (const text of texts) out.push({ text, style });
  };
  const blankBefore = () => {
    if (out.length && last() !== "") push([""]);
  };

  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.trim().startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      push(["    " + line]);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const title = inline(heading[2]).trim();
      blankBefore();
      if (level === 1) push([title.toUpperCase()], "title");
      else if (level === 2) push([title.toUpperCase()], "heading");
      else push([title], "heading");
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blankBefore();
      push(["-".repeat(RULE_WIDTH)]);
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      const indent = " ".repeat(Math.floor(bullet[1].length / 2) * 2);
      push(wrap(inline(bullet[2]), `${indent}• `));
      continue;
    }

    const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      const indent = " ".repeat(Math.floor(ordered[1].length / 2) * 2);
      push(wrap(inline(ordered[3]), `${indent}${ordered[2]}. `));
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      push(wrap(inline(quote[1]), "    "));
      continue;
    }

    push(line.trim() ? wrap(inline(line)) : [""]);
  }

  // Trim leading/trailing blanks and collapse runs of blank lines.
  while (out.length && out[0].text === "") out.shift();
  while (out.length && out[out.length - 1].text === "") out.pop();
  return out.filter((l, i) => !(l.text === "" && i > 0 && out[i - 1].text === ""));
}

export function toText(lines: Line[]): string {
  return lines.length ? lines.map((l) => l.text).join("\n") + "\n" : "";
}

// ---------------------------------------------------------------- lines → PDF

// Built-in Courier uses WinAnsiEncoding; map the typographic characters a brief is likely
// to contain, pass Latin-1 through, and fall back to "?" for anything else.
const WINANSI: Record<string, number> = {
  "\u2022": 0x95, "\u2013": 0x96, "\u2014": 0x97, "\u2018": 0x91, "\u2019": 0x92,
  "\u201c": 0x93, "\u201d": 0x94, "\u2026": 0x85, "\u20ac": 0x80, "\u2122": 0x99,
};

function pdfString(text: string): string {
  let s = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const code = cp < 0x80 || (cp >= 0xa0 && cp <= 0xff) ? cp : WINANSI[ch] ?? 0x3f;
    const c = String.fromCharCode(code);
    s += c === "(" || c === ")" || c === "\\" ? "\\" + c : c;
  }
  return `(${s})`;
}

export function toPdf(lines: Line[]): Buffer {
  const usable = PAGE.height - 2 * PAGE.margin;
  const perPage = Math.floor(usable / LEADING);
  const pages: Line[][] = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  if (!pages.length) pages.push([]);

  const objects: string[] = [];
  const add = (body: string) => objects.push(body) && objects.length; // 1-based object number

  const catalog = add(""); // placeholders filled after page objects exist
  const pagesObj = add("");
  const regular = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
  const bold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>");

  const pageIds: number[] = [];
  for (const page of pages) {
    const ops: string[] = ["BT"];
    let y = PAGE.height - PAGE.margin - FONT_SIZE;
    for (const line of page) {
      if (line.text) {
        const font = line.style === "body" ? "/F1" : "/F2";
        const size = line.style === "title" ? TITLE_SIZE : FONT_SIZE;
        ops.push(`${font} ${size} Tf 1 0 0 1 ${PAGE.margin} ${y.toFixed(1)} Tm ${pdfString(line.text)} Tj`);
      }
      y -= LEADING;
    }
    ops.push("ET");
    const stream = ops.join("\n");
    const content = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] ` +
          `/Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }

  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let body = "%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

// ---------------------------------------------------------------- I/O and CUPS

function readSource(path: string | undefined): string {
  if (path && path !== "-") return readFileSync(path, "utf8");
  if (process.stdin.isTTY) {
    process.stderr.write("print_brief: no --input given and stdin is a terminal; nothing to print\n");
    return "";
  }
  try {
    return readFileSync(0, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EAGAIN") return "";
    throw err;
  }
}

/** Shell-style split for LP_OPTIONS, honoring single/double quotes. */
function shellSplit(input: string): string[] {
  const args: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) args.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
    }
  }
  if (has || cur) args.push(cur);
  return args;
}

type Run = { status: number | null; stdout: string; stderr: string; missing: boolean; timedOut: boolean };

function run(cmd: string, args: string[]): Run {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: LP_TIMEOUT_MS });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    missing: code === "ENOENT",
    timedOut: code === "ETIMEDOUT",
  };
}

/** true/false if `lpstat` can answer; null if `lpstat` is unavailable. */
function printerExists(printer: string): boolean | null {
  const r = run("lpstat", ["-p", printer]);
  if (r.missing) return null;
  return r.status === 0;
}

function sendToPrinter(pdfPath: string, printer: string, extraOptions: string, title: string): number {
  const exists = printerExists(printer);
  if (exists === false) {
    process.stderr.write(
      `print_brief: printer queue '${printer}' not found. Check \`lpstat -p\` or create one with ` +
        `\`lpadmin -p ${printer} -E -v ipp://<printer-host>/ipp/print -m everywhere\`\n`,
    );
    return EXIT_NO_PRINTER;
  }

  const r = run("lp", ["-d", printer, "-t", title, ...DEFAULT_LP_OPTIONS, ...shellSplit(extraOptions), pdfPath]);
  if (r.missing) {
    process.stderr.write("print_brief: `lp` not found; install cups-client (Linux) or use macOS's built-in CUPS\n");
    return EXIT_LP_FAILED;
  }
  if (r.timedOut) {
    process.stderr.write(`print_brief: \`lp\` timed out after ${LP_TIMEOUT_MS / 1000}s (is CUPS running?)\n`);
    return EXIT_LP_FAILED;
  }
  if (r.status !== 0) {
    process.stderr.write(`print_brief: \`lp\` failed (${r.status}): ${r.stderr.trim()}\n`);
    return EXIT_LP_FAILED;
  }

  process.stdout.write(r.stdout.trim() + "\n");
  return 0;
}

function localDate(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function main(argv: string[]): number {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        input: { type: "string", short: "i" },
        "dry-run": { type: "boolean", default: false },
        out: { type: "string" },
        printer: { type: "string" },
        "env-file": { type: "string", default: ".env" },
        help: { type: "boolean", short: "h", default: false },
      },
    }).values;
  } catch (err) {
    process.stderr.write(`print_brief: ${(err as Error).message}\n${HELP}`);
    return 1;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  loadDotenv(args["env-file"]!);

  const lines = renderMarkdown(readSource(args.input));
  const text = toText(lines);
  if (!text.trim()) {
    process.stderr.write("print_brief: brief content is empty; refusing to print a blank page\n");
    return EXIT_EMPTY;
  }

  const today = localDate();
  const outDir = process.env.BRIEF_OUT_DIR || "out";
  const pdfPath = args.out ?? join(outDir, `brief-${today}.pdf`);
  const txtPath = pdfPath.replace(/\.pdf$/i, "") + ".txt";
  mkdirSync(dirname(pdfPath), { recursive: true });
  writeFileSync(txtPath, text, "utf8");
  writeFileSync(pdfPath, toPdf(lines));

  if (args["dry-run"]) {
    process.stdout.write(`dry-run: rendered ${lines.length} lines to ${pdfPath} (+ ${txtPath}); nothing sent to printer\n`);
    return 0;
  }

  const printer = args.printer || process.env.PRINTER_NAME || "";
  if (!printer) {
    process.stderr.write("print_brief: set PRINTER_NAME (or pass --printer); run with --dry-run to skip printing\n");
    return EXIT_NO_PRINTER;
  }

  return sendToPrinter(pdfPath, printer, process.env.LP_OPTIONS ?? "", `Daily brief ${today}`);
}

process.exit(main(process.argv.slice(2)));
