# daily-brief

Grok Bot morning brief → physical printer.

A Grok Bot teammate ("Eng") assembles Matt's brief as Markdown each morning and pipes it into `print_brief.ts`, which renders it to a minimalist uppercase-mono PDF (Letter, 1" margins, Courier) and sends it to a CUPS/IPP printer with `lp`. One TypeScript file, `node:` built-ins only, zero runtime dependencies — the PDF is written by hand so the same file prints identically on any host. Runs with [Bun](https://bun.sh) (or `node --experimental-strip-types` on Node 22.6+).

The page has a fixed shape — small title/date header, then four sections: **Events**, **Interesting things to think about**, **Affirmations**, and **Journaling / Observations / Thoughts**, which is ruled to the bottom of the page for morning-pages handwriting. See `examples/sample-brief.md` for the Markdown Eng should emit.

```sh
# dry run: render to out/brief-YYYY-MM-DD.pdf (+ .txt), print nothing
bun print_brief.ts --dry-run --input examples/sample-brief.md   # or: bun run dry-run
open out/brief-*.pdf                                            # this exact file is what lp sends

# real print (needs PRINTER_NAME in .env or the environment)
cp .env.example .env   # PRINTER_NAME=Brother_HL_L2370DW_series is pre-filled
cat brief.md | bun print_brief.ts
```

- [docs/HANDOFF.md](docs/HANDOFF.md) — routine schedule, env vars, printer setup, failure behavior, dry-run steps for Eng.
- `examples/sample-brief.md` — the Markdown subset the renderer understands.
- `bun install && bun run typecheck` — optional `tsc --noEmit` sanity check (the only dev deps).
