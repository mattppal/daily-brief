# daily-brief

Grok Bot morning brief → physical printer.

A Grok Bot teammate ("Eng") assembles Matt's brief as Markdown each morning and pipes it into `print_brief.py`, which renders it to printer-friendly text and sends it to a CUPS/IPP printer with `lp`. Python 3 stdlib only; no packages to install.

```sh
# dry run: render to out/brief-YYYY-MM-DD.txt, print nothing
python3 print_brief.py --dry-run --input examples/sample-brief.md

# real print (needs PRINTER_NAME in .env or the environment)
cp .env.example .env   # fill in PRINTER_NAME
cat brief.md | python3 print_brief.py
```

- [docs/HANDOFF.md](docs/HANDOFF.md) — routine schedule, env vars, failure behavior, dry-run steps for Eng.
- `examples/sample-brief.md` — the Markdown subset the renderer understands.
