#!/usr/bin/env bun
/**
 * Render a Markdown daily brief to a one-page "bento worksheet" PDF and send it to CUPS.
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
 * The PDF is written by hand with the built-in Courier-Bold (labels) and Helvetica (body)
 * fonts, so the file sent to `lp` prints identically on any host and can be previewed
 * before anything hits paper.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

const EXIT_EMPTY = 2;
const EXIT_NO_PRINTER = 3;
const EXIT_LP_FAILED = 4;

const LP_TIMEOUT_MS = 30_000;

// Page: US Letter portrait, 1" margins. Header is letterspaced Courier-Bold caps; box
// labels reuse that style one point smaller; body copy is Helvetica.
const PAGE = { width: 612, height: 792, margin: 72 };
const HEAD = { size: 8, tracking: 1.5 };
const LABEL = { size: 7, tracking: 1.5 };
const BODY = { size: 10, leading: 14 };
// Bento grid: two boxes on top, full-width affirmations, journaling takes the rest.
const GRID = { gutter: 12, pad: 12, border: 0.6, headerGap: 22, labelGap: 18 };
const TOP_ROW = { min: 132, max: 240 };
const MIDDLE_ROW = { min: 62, max: 120 };
// Morning-pages ruling inside the journaling box.
const RULING = { gap: 24, gray: 0.8, width: 0.4 };
const DEFAULT_SECTIONS = ["Events", "Interesting things to think about", "Affirmations"];
const JOURNAL_HEADING = "Journaling / Observations / Thoughts";
const TEXT_WIDTH = 72; // wrap width for the .txt companion file

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

// ---------------------------------------------------------------- Markdown → sections

/** One list item or paragraph; `prefix` ("• ", "1. ", "") hangs on wrapped continuation lines. */
type Item = { prefix: string; text: string };
type Section = { label: string; items: Item[] };
export type Brief = { title: string; date: string; sections: Section[]; journal: string };

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
  return text.replace(/\s+/g, " ").trim();
}

function longDate(): string {
  return new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

/**
 * Parse a Markdown subset into the fixed bento structure. The first `#` is the title
 * (default "Daily Brief"); each `##` opens a section; a heading starting with "journal"
 * names the ruled morning-pages box. Sections map to boxes in order: the first two share
 * the top row, the third is the full-width middle row; missing ones get default labels.
 */
export function renderMarkdown(md: string): Brief {
  let title = "Daily Brief";
  let journal = JOURNAL_HEADING;
  const sections: Section[] = [];
  let current: Section | null = null;
  let inCode = false;

  const add = (prefix: string, text: string) => {
    if (!text) return;
    if (!current) {
      current = { label: DEFAULT_SECTIONS[0], items: [] };
      sections.push(current);
    }
    current.items.push({ prefix, text });
  };

  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.trim().startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      add("", line.trim());
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const text = inline(heading[2]);
      if (heading[1].length === 1) title = text;
      else if (/^journal/i.test(text)) {
        journal = text;
        current = null; // anything under the journaling heading is ignored: it is writing room
      } else {
        current = { label: text, items: [] };
        sections.push(current);
      }
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue;

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      add("• ", inline(bullet[1]));
      continue;
    }
    const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      add(`${ordered[1]}. `, inline(ordered[2]));
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      add("", inline(quote[1]));
      continue;
    }
    if (line.trim()) add("", inline(line));
  }

  const filled = sections.filter((s) => s.items.length || sections.indexOf(s) < 3);
  while (filled.length < 3) filled.push({ label: DEFAULT_SECTIONS[filled.length], items: [] });
  return { title: title.toUpperCase(), date: longDate().toUpperCase(), sections: filled, journal };
}

export function isEmpty(brief: Brief): boolean {
  return !brief.sections.some((s) => s.items.length);
}

/** Word-wrap using `measure` for widths; `prefix` hangs on continuation lines. */
function wrapItem(item: Item, maxWidth: number, measure: (s: string) => number): string[] {
  const indent = " ".repeat(item.prefix.length);
  const lines: string[] = [];
  let cur = item.prefix;
  let bare = true;
  for (const word of item.text.split(" ")) {
    const candidate = bare ? cur + word : `${cur} ${word}`;
    if (!bare && measure(candidate) > maxWidth) {
      lines.push(cur);
      cur = indent + word;
    } else {
      cur = candidate;
    }
    bare = false;
  }
  lines.push(cur);
  return lines;
}

export function toText(brief: Brief): string {
  if (isEmpty(brief)) return "";
  const out = [`${brief.title}  ·  ${brief.date}`, ""];
  for (const s of brief.sections) {
    out.push(s.label.toUpperCase());
    for (const item of s.items) out.push(...wrapItem(item, TEXT_WIDTH, (t) => t.length));
    out.push("");
  }
  out.push(brief.journal.toUpperCase(), "", "_".repeat(TEXT_WIDTH));
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------- sections → PDF

// Built-in fonts use WinAnsiEncoding; map the typographic characters a brief is likely to
// contain, pass Latin-1 through, and fall back to "?" for anything else.
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

// Helvetica advance widths (AFM, per 1000 em) for ASCII 0x20–0x7E, plus the few
// typographic extras above. Anything else is assumed average width.
const HELVETICA_ASCII = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_EXTRA: Record<string, number> = {
  "\u2022": 350, "\u2013": 556, "\u2014": 1000, "\u2018": 222, "\u2019": 222,
  "\u201c": 333, "\u201d": 333, "\u2026": 1000, "\u00b0": 400, "\u00a0": 278,
};

function helveticaWidth(text: string, size: number): number {
  let units = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    units += cp >= 0x20 && cp <= 0x7e ? HELVETICA_ASCII[cp - 0x20] : HELVETICA_EXTRA[ch] ?? 556;
  }
  return (units / 1000) * size;
}

function monoWidth(text: string, size: number, tracking: number): number {
  const n = [...text].length;
  return n * size * 0.6 + Math.max(0, n - 1) * tracking;
}

const F_MONO = "/F1";
const F_SANS = "/F2";

function textOp(text: string, x: number, y: number, font: string, size: number, tracking = 0): string {
  return `BT ${font} ${size} Tf ${tracking} Tc 1 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)} Tm ${pdfString(text)} Tj ET`;
}

/** Lines a section needs at `width`, plus the box height that would hold them all. */
function layoutSection(section: Section, width: number): { lines: string[]; height: number } {
  const inner = width - 2 * GRID.pad;
  const lines = section.items.flatMap((item) => wrapItem(item, inner, (t) => helveticaWidth(t, BODY.size)));
  const height = 2 * GRID.pad + LABEL.size + GRID.labelGap + Math.max(0, lines.length - 1) * BODY.leading + (lines.length ? BODY.size : 0);
  return { lines, height };
}

/** Draw one bento box: border, mono caps label, and as many body lines as fit ("…" if clipped). */
function drawBox(ops: string[], x: number, top: number, width: number, height: number, label: string, lines: string[]): void {
  ops.push(`0 G ${GRID.border} w ${x} ${(top - height).toFixed(1)} ${width} ${height} re S`);
  const labelY = top - GRID.pad - LABEL.size;
  ops.push(textOp(label.toUpperCase(), x + GRID.pad, labelY, F_MONO, LABEL.size, LABEL.tracking));
  let y = labelY - GRID.labelGap;
  const bottom = top - height + GRID.pad;
  const fit = Math.max(0, Math.floor((y - bottom) / BODY.leading) + 1);
  const shown = lines.length > fit ? [...lines.slice(0, Math.max(0, fit - 1)), "…"] : lines;
  for (const line of shown) {
    ops.push(textOp(line, x + GRID.pad, y, F_SANS, BODY.size));
    y -= BODY.leading;
  }
}

export function toPdf(brief: Brief): Buffer {
  const left = PAGE.margin;
  const right = PAGE.width - PAGE.margin;
  const bottom = PAGE.margin;
  const fullWidth = right - left;
  const colWidth = (fullWidth - GRID.gutter) / 2;
  const ops: string[] = [];

  // Header: title left, date right — small bold letterspaced mono caps.
  let y = PAGE.height - PAGE.margin - HEAD.size;
  ops.push(textOp(brief.title, left, y, F_MONO, HEAD.size, HEAD.tracking));
  ops.push(textOp(brief.date, right - monoWidth(brief.date, HEAD.size, HEAD.tracking), y, F_MONO, HEAD.size, HEAD.tracking));
  y -= GRID.headerGap;

  // Top row: two boxes sharing one height.
  const [a, b, c] = brief.sections;
  const la = layoutSection(a, colWidth);
  const lb = layoutSection(b, colWidth);
  const topHeight = Math.min(TOP_ROW.max, Math.max(TOP_ROW.min, la.height, lb.height));
  drawBox(ops, left, y, colWidth, topHeight, a.label, la.lines);
  drawBox(ops, left + colWidth + GRID.gutter, y, colWidth, topHeight, b.label, lb.lines);
  y -= topHeight + GRID.gutter;

  // Middle row: full-width affirmations.
  const lc = layoutSection(c, fullWidth);
  const midHeight = Math.min(MIDDLE_ROW.max, Math.max(MIDDLE_ROW.min, lc.height));
  drawBox(ops, left, y, fullWidth, midHeight, c.label, lc.lines);
  y -= midHeight + GRID.gutter;

  // Bottom: journaling takes whatever is left, ruled for handwriting.
  const journalHeight = y - bottom;
  drawBox(ops, left, y, fullWidth, journalHeight, brief.journal, []);
  ops.push(`${RULING.gray} G ${RULING.width} w`);
  const firstRule = y - GRID.pad - LABEL.size - RULING.gap;
  for (let ry = firstRule; ry >= bottom + GRID.pad; ry -= RULING.gap) {
    ops.push(`${left + GRID.pad} ${ry.toFixed(1)} m ${right - GRID.pad} ${ry.toFixed(1)} l S`);
  }

  const objects: string[] = [];
  const addObj = (body: string) => objects.push(body) && objects.length; // 1-based object number
  const catalog = addObj(""); // placeholders filled once the page object exists
  const pagesObj = addObj("");
  const mono = addObj("<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>");
  const sans = addObj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const stream = ops.join("\n");
  const content = addObj(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
  const page = addObj(
    `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] ` +
      `/Resources << /Font << ${F_MONO} ${mono} 0 R ${F_SANS} ${sans} 0 R >> >> /Contents ${content} 0 R >>`,
  );
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`;

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

  const brief = renderMarkdown(readSource(args.input));
  const text = toText(brief);
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
  writeFileSync(pdfPath, toPdf(brief));

  if (args["dry-run"]) {
    const items = brief.sections.reduce((n, s) => n + s.items.length, 0);
    process.stdout.write(`dry-run: rendered ${items} items to ${pdfPath} (+ ${txtPath}); nothing sent to printer\n`);
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
