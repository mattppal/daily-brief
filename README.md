# daily-brief

Grok Bot morning brief → physical printer.

A Grok Bot teammate ("Eng") assembles Matt's brief as Markdown each morning and pipes it into `print_brief.ts`, which renders it to printer-friendly text and sends it to a CUPS/IPP printer with `lp`. One TypeScript file, `node:` built-ins only, zero runtime dependencies. Runs with [Bun](https://bun.sh) (or `node --experimental-strip-types` on Node 22.6+).

```sh
# dry run: render to out/brief-YYYY-MM-DD.txt, print nothing
bun print_brief.ts --dry-run --input examples/sample-brief.md   # or: bun run dry-run

# real print (needs PRINTER_NAME in .env or the environment)
cp .env.example .env   # PRINTER_NAME=Brother_HL_L2370DW_series is pre-filled
cat brief.md | bun print_brief.ts
```

- [docs/HANDOFF.md](docs/HANDOFF.md) — routine schedule, env vars, printer setup, failure behavior, dry-run steps for Eng.
- `examples/sample-brief.md` — the Markdown subset the renderer understands.
- `bun install && bun run typecheck` — optional `tsc --noEmit` sanity check (the only dev deps).
