# daily-brief

Grok Bot morning brief → physical printer.

A Grok Bot teammate ("Eng") assembles Matt's brief as Markdown each morning and pipes it into `print_brief.ts`, which renders it to a one-page "bento worksheet" PDF (Letter portrait, ~0.56" margins) and sends it to a CUPS/IPP printer with `lp`. One TypeScript file, `node:` built-ins only, zero runtime dependencies — the PDF is written by hand so the same file prints identically on any host. Runs with [Bun](https://bun.sh) (or `node --experimental-strip-types` on Node 22.6+).

The page has a fixed shape, somewhere between Japanese stationery and an Apple bento: a quiet tracked-caps header (title left, date right), a 2×2 grid of rounded hairline cards — **Events** (timeline: time column, dotted spine) | **Interesting things to think about** (text) over **Affirmations** (blank ruled space, written by hand) | **Physical health** (checkboxes) — and a **Journaling / Observations / Thoughts** card ruled like a notebook page for morning-pages handwriting. Everything is set in Helvetica (built-in PDF font, so no font files are shipped): gray letterspaced caps for labels, black 10pt for body. See `examples/sample-brief.md` for the Markdown Eng should emit.

```sh
# dry run: render to out/brief-YYYY-MM-DD.pdf (+ .txt), print nothing
bun print_brief.ts --dry-run --input examples/sample-brief.md   # or: bun run dry-run
open out/brief-*.pdf                                            # this exact file is what lp sends

# real print (needs PRINTER_NAME in .env or the environment)
cp .env.example .env   # PRINTER_NAME=Brother_HL_L2370DW_series is pre-filled
cat brief.md | bun print_brief.ts
```

- [docs/architecture.md](docs/architecture.md) — the multi-bot shape (source bots → orchestrator → printer bot), section-to-source map, print path options, routine, and the Markdown contract.
- [docs/HANDOFF.md](docs/HANDOFF.md) — routine schedule, env vars, printer setup, failure behavior, dry-run steps for Eng.
- `examples/sample-brief.md` — the Markdown subset the renderer understands.
- `bun install && bun run typecheck` — optional `tsc --noEmit` sanity check (the only dev deps).
