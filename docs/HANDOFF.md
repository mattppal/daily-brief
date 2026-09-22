# Handoff for Eng (Grok Bot morning routine)

You own the morning wake/routine. This repo owns two things: turning brief Markdown into a one-page bento-worksheet PDF with a fixed section structure, and getting it onto Matt's printer via CUPS. Everything runs from one command.

## The one command

```sh
# real print
cat brief.md | bun print_brief.ts

# or from a file
bun print_brief.ts --input brief.md
```

Requirements on the host that runs it: [Bun](https://bun.sh) (`brew install oven-sh/bun/bun` or `curl -fsSL https://bun.sh/install | bash`) and CUPS (`lp`/`lpstat`). macOS has CUPS built in; on Debian/Ubuntu `apt install cups-client`. No `bun install` is needed to run — the script uses only `node:` built-ins. If Bun is unavailable, `node --experimental-strip-types print_brief.ts …` works on Node 22.6+.

**The host must be able to reach the printer** (same LAN, or a `CUPS_SERVER` that can). If your routine runs somewhere else, trigger this command on Matt's Mac / a Pi rather than running it where you are.

## Suggested routine

| When | What |
|---|---|
| 06:45 local, Mon–Fri | Assemble the brief as Markdown → pipe into `print_brief.ts` |
| Any time you change the brief format | Run with `--dry-run` first and inspect `out/brief-YYYY-MM-DD.txt` |
| Once at setup | Confirm `lpstat -p "$PRINTER_NAME"` shows the queue |

Run it once per morning. If the exit code is 0, the job is in CUPS — do **not** retry, even if the printer looks idle (see failure behavior).

## Brief content

Assumption: you already produce the brief; this script only formats and prints it. Feed it Markdown on stdin or via `--input`, shaped like `examples/sample-brief.md`:

```md
# Daily Brief

## Events
- 09:00 Standup
- …

## Interesting things to think about
- …

## Affirmations
- …

## Physical health
- …

## Journaling / Observations / Thoughts
```

The five `##` sections are the page's fixed structure — keep the order. Sections map to cards by position in a 2×2 grid: row one is **Events | Interesting things to think about**, row two is **Affirmations | Physical health** (workout / movement / recovery), and the journaling heading (anything starting with "journal") names the large ruled card that fills the rest of the page. Missing sections are still drawn with their default labels; anything written under the journaling heading is ignored — that card is handwriting room.

Supported Markdown: `#` title (defaults to "Daily Brief"; today's date is added automatically), `##` headings, `-`/`*` bullets, numbered lists, `>` quotes, `**bold**`/`*italic*`/`` `code` `` (markers stripped), links (rendered as `text (url)`), fenced code blocks. `---` rules are dropped.

Layout is fixed in the script: Letter portrait, 1" margins, cards with 8pt rounded corners and 0.5pt gray hairline borders, 14pt padding and gutters, no footer. Typography is all Helvetica (the PDF built-in, so the repo ships no font files): header in 9pt gray letterspaced caps, card labels in 7pt bold gray letterspaced caps, body in black 10pt on 14pt leading. The journaling card is ruled every 22pt with very light lines and a little air under the label, like a good notebook. It is always exactly one page: each card holds about 7 lines before the text is clipped with "…", rows size to their taller card, and journaling takes whatever height is left (never less than ~3"; ~4" with the sample). Aim for 3–4 short items per card. Non-Latin-1 characters fall back to `?`, so stick to plain text, `•`, dashes and curly quotes.

## Matt's printer

| | |
|---|---|
| Model | Brother HL-L2370DW — mono laser, auto duplex, Letter |
| CUPS queue on Matt's Mac | `Brother_HL_L2370DW_series` (system default) |
| Device URI | `ipp://BRWCC6B1E08C933.local.:631/ipp/print` (AirPrint / IPP Everywhere) |

Check it's there: `lpstat -p Brother_HL_L2370DW_series`. List supported options (paper sizes, duplex modes, etc.): `lpoptions -p Brother_HL_L2370DW_series -l`.

### Recreating the queue on another LAN host (e.g. a Pi)

```sh
lpadmin -p Brother_HL_L2370DW_series -E -v ipp://BRWCC6B1E08C933.local.:631/ipp/print -m everywhere
lpstat -p Brother_HL_L2370DW_series
```

The `.local.` hostname is mDNS — on Linux install `avahi-daemon` (and `libnss-mdns`) first, or substitute the printer's IP address in the URI.

## Environment variables

Copy `.env.example` to `.env` next to the script (or export them). `.env` is gitignored; never commit real values.

| Var | Required | Example | Meaning |
|---|---|---|---|
| `PRINTER_NAME` | for real prints | `Brother_HL_L2370DW_series` | CUPS queue name from `lpstat -p` |
| `CUPS_SERVER` | no | `matts-mac.local` | `host[:port]` of a remote CUPS server; `lp` honors it natively |
| `LP_OPTIONS` | no | `-o sides=two-sided-long-edge` | extra `lp` flags, appended after the built-in `-o media=Letter` (so `-o media=A4` overrides it); use `sides=one-sided` if Matt prefers single-sided |
| `BRIEF_OUT_DIR` | no | `out` | where the rendered PDF and text are written (default `out/`) |

`--printer NAME` overrides `PRINTER_NAME`; `--out PATH` sets the PDF path (a `.txt` with the same stem is written next to it); `--env-file PATH` picks a different dotenv.

## Failure behavior

| Situation | What happens | Exit |
|---|---|---|
| Content empty / whitespace only | Nothing is rendered or printed; stderr says so | 2 |
| `PRINTER_NAME` unset (and no `--printer`) | PDF/text are rendered to `out/`, nothing printed | 3 |
| Queue name not known to CUPS (`lpstat -p` fails) | Nothing submitted; stderr shows the `lpadmin` hint | 3 |
| `lp` missing, errors, or hangs >30s | Nothing (or partially) submitted; stderr has `lp`'s message | 4 |
| Printer **offline / out of paper** but queue exists | `lp` succeeds and CUPS holds the job; it prints when the printer comes back | 0 |

That last row matters: a 0 exit means "queued", not "paper is out of the printer". Don't re-run on a 0 or Matt gets duplicates. To see what's pending: `lpstat -o`; to cancel: `cancel -a "$PRINTER_NAME"`.

The rendered PDF and text are always written to `out/brief-YYYY-MM-DD.{pdf,txt}` (even on real prints), so you can attach or re-send them if something went wrong.

## Dry run (no paper)

```sh
bun print_brief.ts --dry-run --input examples/sample-brief.md   # or: bun run dry-run
open out/brief-$(date +%F).pdf      # exactly the file lp would send
cat  out/brief-$(date +%F).txt      # quick look without a PDF viewer
```

`--dry-run` never calls `lp` and doesn't need `PRINTER_NAME` or CUPS installed. Use `--out /tmp/x.pdf` to pick the path. Matt should approve the dry-run PDF before the first real print.

## Not in scope (yet)

- Fetching brief content from anywhere — you provide it.
- Inter (or any embedded font). Everything uses built-in Helvetica so the repo ships no binaries; on a mono laser the difference from Inter is slight. To move to Inter: subset `Inter-Regular.ttf`/`Inter-SemiBold.ttf` to WinAnsi with `pyftsubset` (fonttools), embed each as a `FontFile2` stream with a `FontDescriptor`, and read advance widths from `hmtx` for wrapping — roughly 80 lines plus the font files.
- A daemon or cloud print relay. Only needed if no LAN host can run the command.
