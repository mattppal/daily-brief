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
 * The PDF is written by hand with the built-in Helvetica family, so the file sent to `lp`
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

// Page: US Letter portrait, ~0.56" margins (well inside a laser's ~0.17" hardware margin),
// Helvetica throughout. Stationery feel: quiet tracked-caps header and card labels in
// gray, black body copy, hairline rounded cards.
const PAGE = { width: 612, height: 792, margin: 40 };
const HEAD = { size: 9, tracking: 2.2, gray: 0.35 };
const LABEL = { size: 7, tracking: 1.4, gray: 0.45 };
const BODY = { size: 10, leading: 14 };
// Bento grid: 2×2 cards then journaling takes whatever height is left. Cards map to
// sections by position; each has a presentation kind. Rows size to content within
// [min, max]; `split` is the left card's share of the row width.
const GRID = { gutter: 14, pad: 14, radius: 8, border: 0.5, borderGray: 0.6, headerGap: 24, labelGap: 18 };
type Kind = "timeline" | "text" | "ruled" | "checklist";
const CARDS: Array<{ label: string; kind: Kind }> = [
  { label: "Events", kind: "timeline" },
  { label: "Interesting things to think about", kind: "text" },
  { label: "Affirmations", kind: "ruled" },
  { label: "Physical health", kind: "checklist" },
];
const ROWS = [
  { min: 150, max: 190, split: 0.5 },
  { min: 176, max: 216, split: 0.58 },
];
// Notebook-style ruling (journaling, affirmations): light, even, with air under the label.
const RULING = { gap: 22, gray: 0.86, width: 0.35, topMargin: 30 };
// Timeline (events): gray time column, hairline spine with dots, text to the right.
const TIMELINE = { timeWidth: 30, timeSize: 9, timeGray: 0.45, spineGap: 10, spineGray: 0.75, dotRadius: 1.8, dotGray: 0.3 };
const CHECKBOX = { size: 8, radius: 1.5, gray: 0.45, gap: 14 };
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
      current = { label: CARDS[0].label, items: [] };
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

    const bullet = /^\s*[-*+]\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
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

  const slots = CARDS.length;
  const filled = sections.filter((s) => s.items.length || sections.indexOf(s) < slots);
  while (filled.length < slots) filled.push({ label: CARDS[filled.length].label, items: [] });
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
  brief.sections.forEach((s, i) => {
    out.push(s.label.toUpperCase());
    const kind = CARDS[i]?.kind;
    for (const item of s.items) {
      const prefix = kind === "checklist" ? "[ ] " : item.prefix;
      out.push(...wrapItem({ prefix, text: item.text }, TEXT_WIDTH, (t) => t.length));
    }
    if (kind === "ruled" && !s.items.length) out.push("_".repeat(TEXT_WIDTH));
    out.push("");
  });
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

function trackedWidth(text: string, size: number, tracking: number): number {
  return helveticaWidth(text, size) + Math.max(0, [...text].length - 1) * tracking;
}

const F_SANS = "/F1";
const F_SANS_BOLD = "/F2";

function textOp(text: string, x: number, y: number, font: string, size: number, tracking = 0, gray = 0): string {
  return `BT ${gray} g ${font} ${size} Tf ${tracking} Tc 1 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)} Tm ${pdfString(text)} Tj ET`;
}

/** Rounded-rectangle path (Bézier corners) stroked as a hairline. */
function roundedRect(x: number, y: number, w: number, h: number, r: number): string {
  const k = 0.5523 * r;
  const f = (n: number) => n.toFixed(2);
  return [
    `${f(x + r)} ${f(y)} m`,
    `${f(x + w - r)} ${f(y)} l ${f(x + w - r + k)} ${f(y)} ${f(x + w)} ${f(y + r - k)} ${f(x + w)} ${f(y + r)} c`,
    `${f(x + w)} ${f(y + h - r)} l ${f(x + w)} ${f(y + h - r + k)} ${f(x + w - r + k)} ${f(y + h)} ${f(x + w - r)} ${f(y + h)} c`,
    `${f(x + r)} ${f(y + h)} l ${f(x + r - k)} ${f(y + h)} ${f(x)} ${f(y + h - r + k)} ${f(x)} ${f(y + h - r)} c`,
    `${f(x)} ${f(y + r)} l ${f(x)} ${f(y + r - k)} ${f(x + r - k)} ${f(y)} ${f(x + r)} ${f(y)} c`,
    "h S",
  ].join(" ");
}

/** One visual row of a card: optional time (timeline), optional checkbox, wrapped text lines. */
type Row = { time?: string; box?: boolean; lines: string[] };

const measure = (t: string) => helveticaWidth(t, BODY.size);

/** Text x-offset inside the card body for each kind (timeline/checklist reserve a gutter). */
function textIndent(kind: Kind): number {
  if (kind === "timeline") return TIMELINE.timeWidth + 2 * TIMELINE.spineGap;
  if (kind === "checklist") return CHECKBOX.size + CHECKBOX.gap - CHECKBOX.size / 2 + 4;
  return 0;
}

/** Lay a section out as rows for its card kind, and the card height that would hold them all. */
function layoutSection(section: Section, kind: Kind, width: number): { rows: Row[]; height: number } {
  const inner = width - 2 * GRID.pad - textIndent(kind);
  const rows: Row[] = section.items.map((item) => {
    if (kind === "timeline") {
      const m = /^(\d{1,2}:\d{2}\s*(?:[ap]m)?)\s*[–—-]?\s*(.*)$/i.exec(item.text);
      const text = m ? m[2] : item.text;
      return { time: m?.[1].replace(/\s+/g, ""), lines: wrapItem({ prefix: "", text }, inner, measure) };
    }
    if (kind === "checklist") return { box: true, lines: wrapItem({ prefix: "", text: item.text }, inner, measure) };
    return { lines: wrapItem(item, inner, measure) };
  });
  const n = rows.reduce((sum, r) => sum + r.lines.length, 0);
  const height = 2 * GRID.pad + LABEL.size + GRID.labelGap + Math.max(0, n - 1) * BODY.leading + (n ? BODY.size : 0);
  return { rows, height };
}

/** Faint notebook rules from `fromY` down to `toY`. */
function drawRuling(ops: string[], x1: number, x2: number, fromY: number, toY: number): void {
  ops.push(`${RULING.gray} G ${RULING.width} w`);
  for (let ry = fromY; ry >= toY; ry -= RULING.gap) {
    ops.push(`${x1.toFixed(1)} ${ry.toFixed(1)} m ${x2.toFixed(1)} ${ry.toFixed(1)} l S`);
  }
}

/** Draw one bento card: hairline rounded border, quiet caps label, then the body for its kind. */
function drawCard(ops: string[], x: number, top: number, width: number, height: number, label: string, kind: Kind, rows: Row[]): void {
  ops.push(`${GRID.borderGray} G ${GRID.border} w ${roundedRect(x, top - height, width, height, GRID.radius)}`);
  const labelY = top - GRID.pad - LABEL.size;
  ops.push(textOp(label.toUpperCase(), x + GRID.pad, labelY, F_SANS_BOLD, LABEL.size, LABEL.tracking, LABEL.gray));
  const x0 = x + GRID.pad;
  const textX = x0 + textIndent(kind);
  const bottom = top - height + GRID.pad;
  let y = labelY - GRID.labelGap;

  // Clip to the lines that fit; the last visible line becomes "…" when anything is cut.
  const fit = Math.max(0, Math.floor((y - bottom) / BODY.leading) + 1);
  const total = rows.reduce((n, r) => n + r.lines.length, 0);
  let budget = total > fit ? fit - 1 : total;
  const shown: Row[] = [];
  for (const r of rows) {
    if (budget <= 0) break;
    shown.push({ ...r, lines: r.lines.slice(0, budget) });
    budget -= r.lines.length;
  }
  if (total > fit) shown.push({ lines: ["…"] });

  const firstY = y;
  for (const r of shown) {
    if (r.time) {
      const tx = x0 + TIMELINE.timeWidth - helveticaWidth(r.time, TIMELINE.timeSize);
      ops.push(textOp(r.time, tx, y, F_SANS, TIMELINE.timeSize, 0, TIMELINE.timeGray));
    }
    if (kind === "timeline" && r.time !== undefined) {
      const cx = x0 + TIMELINE.timeWidth + TIMELINE.spineGap;
      const cy = y + BODY.size * 0.35;
      const rr = TIMELINE.dotRadius;
      const k = 0.5523 * rr;
      ops.push(
        `${TIMELINE.dotGray} g ${cx + rr} ${cy} m ${cx + rr} ${cy + k} ${cx + k} ${cy + rr} ${cx} ${cy + rr} c ` +
          `${cx - k} ${cy + rr} ${cx - rr} ${cy + k} ${cx - rr} ${cy} c ${cx - rr} ${cy - k} ${cx - k} ${cy - rr} ${cx} ${cy - rr} c ` +
          `${cx + k} ${cy - rr} ${cx + rr} ${cy - k} ${cx + rr} ${cy} c f`,
      );
    }
    if (r.box) {
      const s = CHECKBOX.size;
      ops.push(`${CHECKBOX.gray} G 0.6 w ${roundedRect(x0, y - 1, s, s, CHECKBOX.radius)}`);
    }
    for (const line of r.lines) {
      ops.push(textOp(line, textX, y, F_SANS, BODY.size));
      y -= BODY.leading;
    }
  }

  if (kind === "timeline" && shown.some((r) => r.time)) {
    // Spine: a hairline joining the dots, drawn behind them is unnecessary since dots are filled.
    const sx = x0 + TIMELINE.timeWidth + TIMELINE.spineGap;
    const lastY = y + BODY.leading + BODY.size * 0.35;
    ops.push(`${TIMELINE.spineGray} G 0.5 w ${sx} ${(firstY + BODY.size * 0.35).toFixed(1)} m ${sx} ${lastY.toFixed(1)} l S`);
  }
  if (kind === "ruled") {
    // Handwriting room: rule from below whatever text was printed down to the padding.
    const start = shown.length ? y - (RULING.gap - BODY.leading) : labelY - RULING.topMargin;
    drawRuling(ops, x0, x + width - GRID.pad, start, bottom);
  }
}

export function toPdf(brief: Brief): Buffer {
  const left = PAGE.margin;
  const right = PAGE.width - PAGE.margin;
  const bottom = PAGE.margin;
  const fullWidth = right - left;
  const ops: string[] = [];

  // Header: title left, date right — small bold letterspaced mono caps.
  let y = PAGE.height - PAGE.margin - HEAD.size;
  ops.push(textOp(brief.title, left, y, F_SANS, HEAD.size, HEAD.tracking, HEAD.gray));
  const dateX = right - trackedWidth(brief.date, HEAD.size, HEAD.tracking);
  ops.push(textOp(brief.date, dateX, y, F_SANS, HEAD.size, HEAD.tracking, HEAD.gray));
  y -= GRID.headerGap;

  // 2×2 cards; each row shares one height sized to its taller card.
  ROWS.forEach((row, i) => {
    const [l, r] = [brief.sections[2 * i], brief.sections[2 * i + 1]];
    const [kl, kr] = [CARDS[2 * i].kind, CARDS[2 * i + 1].kind];
    const leftWidth = Math.round((fullWidth - GRID.gutter) * row.split);
    const rightWidth = fullWidth - GRID.gutter - leftWidth;
    const ll = layoutSection(l, kl, leftWidth);
    const lr = layoutSection(r, kr, rightWidth);
    const rowHeight = Math.min(row.max, Math.max(row.min, ll.height, lr.height));
    drawCard(ops, left, y, leftWidth, rowHeight, l.label, kl, ll.rows);
    drawCard(ops, left + leftWidth + GRID.gutter, y, rightWidth, rowHeight, r.label, kr, lr.rows);
    y -= rowHeight + GRID.gutter;
  });

  // Journaling takes whatever is left, ruled like a notebook page.
  drawCard(ops, left, y, fullWidth, y - bottom, brief.journal, "ruled", []);

  const objects: string[] = [];
  const addObj = (body: string) => objects.push(body) && objects.length; // 1-based object number
  const catalog = addObj(""); // placeholders filled once the page object exists
  const pagesObj = addObj("");
  const sans = addObj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const sansBold = addObj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const stream = ops.join("\n");
  const content = addObj(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
  const page = addObj(
    `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] ` +
      `/Resources << /Font << ${F_SANS} ${sans} 0 R ${F_SANS_BOLD} ${sansBold} 0 R >> >> /Contents ${content} 0 R >>`,
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
