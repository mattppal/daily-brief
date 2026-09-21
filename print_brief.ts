#!/usr/bin/env bun
/**
 * Render a Markdown daily brief to printer-friendly text and send it to CUPS.
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
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

const EXIT_EMPTY = 2;
const EXIT_NO_PRINTER = 3;
const EXIT_LP_FAILED = 4;

const LINE_WIDTH = 80;
const LP_TIMEOUT_MS = 30_000;

const HELP = `Usage: bun print_brief.ts [--input FILE] [--dry-run] [--out PATH] [--printer QUEUE] [--env-file PATH]

  -i, --input FILE   Markdown file to print (default: stdin)
      --dry-run      render to a file and print nothing
      --out PATH     output path for --dry-run (default: $BRIEF_OUT_DIR/brief-YYYY-MM-DD.txt)
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

/**
 * Convert a Markdown subset to plain text suited to CUPS's text filter.
 * Headings become uppercase/underlined, list markers are normalised, emphasis/code/link
 * syntax is stripped, and fenced code blocks are indented verbatim.
 */
export function renderMarkdown(md: string): string {
  const out: string[] = [];
  let inCode = false;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.trim().startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push("    " + line);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      let title = inline(heading[2]).trim();
      if (level === 1) title = title.toUpperCase();
      const underline = (level === 1 ? "=" : "-").repeat(Math.min(title.length, LINE_WIDTH));
      if (out.length && out[out.length - 1] !== "") out.push("");
      out.push(title, underline);
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("-".repeat(LINE_WIDTH));
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      const indent = " ".repeat(Math.floor(bullet[1].length / 2) * 2);
      out.push(`${indent}* ${inline(bullet[2])}`);
      continue;
    }

    const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      const indent = " ".repeat(Math.floor(ordered[1].length / 2) * 2);
      out.push(`${indent}${ordered[2]}. ${inline(ordered[3])}`);
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      out.push(`  | ${inline(quote[1])}`);
      continue;
    }

    out.push(inline(line));
  }

  let text = out.join("\n").replace(/^\n+|\n+$/g, "");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text ? text + "\n" : "";
}

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

function sendToPrinter(textPath: string, printer: string, extraOptions: string, title: string): number {
  const exists = printerExists(printer);
  if (exists === false) {
    process.stderr.write(
      `print_brief: printer queue '${printer}' not found. Check \`lpstat -p\` or create one with ` +
        `\`lpadmin -p ${printer} -E -v ipp://<printer-host>/ipp/print -m everywhere\`\n`,
    );
    return EXIT_NO_PRINTER;
  }

  const r = run("lp", ["-d", printer, "-t", title, ...shellSplit(extraOptions), textPath]);
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

  const text = renderMarkdown(readSource(args.input));
  if (!text.trim()) {
    process.stderr.write("print_brief: brief content is empty; refusing to print a blank page\n");
    return EXIT_EMPTY;
  }

  const today = localDate();
  const outDir = process.env.BRIEF_OUT_DIR || "out";
  const outPath = args.out ?? join(outDir, `brief-${today}.txt`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, text, "utf8");

  if (args["dry-run"]) {
    process.stdout.write(
      `dry-run: rendered ${text.split("\n").length - 1} lines to ${outPath}; nothing sent to printer\n`,
    );
    return 0;
  }

  const printer = args.printer || process.env.PRINTER_NAME || "";
  if (!printer) {
    process.stderr.write("print_brief: set PRINTER_NAME (or pass --printer); run with --dry-run to skip printing\n");
    return EXIT_NO_PRINTER;
  }

  return sendToPrinter(outPath, printer, process.env.LP_OPTIONS ?? "", `Daily brief ${today}`);
}

process.exit(main(process.argv.slice(2)));
