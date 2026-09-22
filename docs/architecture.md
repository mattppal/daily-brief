# Daily Brief — architecture

A one-page morning worksheet, assembled by Grok Bots and printed on Matt's Brother HL-L2370DW. This document describes the intended multi-bot shape and the contract between the pieces. Only the printer half exists in this repo today; the bots are design.

```
  Google Calendar ──▶ Events bot ─────────────┐
  Notion / X / …  ──▶ Thoughts bot ───────────┤   fragments        Markdown           PDF
  matt-trains     ──▶ Health bot ─────────────┼──────────▶ Orchestrator ──────▶ Printer bot ──────▶ CUPS/IPP ──▶ Brother
  (nothing)           Affirmations, Journal ──┘  (per section)  (chief of staff)  (bun print_brief.ts)   lp        HL-L2370DW
```

## System shape

**Source bots** — one Grok Bot per data source. Each owns exactly one section and emits a *fragment*: the section's `##` heading plus its items, in the template syntax below. A source bot knows nothing about paper.

**Orchestrator ("chief of staff")** — merges fragments into the single Markdown document the printer expects, in the fixed section order. It fills gaps (an empty `## Affirmations`, an empty `## Journaling / Observations / Thoughts`), drops anything that isn't one of the five sections, and trims to the per-card budgets so nothing is clipped on paper. It is the only component that knows the full template.

**Printer bot** — owns the morning routine: receives the assembled Markdown, runs `bun print_brief.ts` (optionally `--dry-run` first), and submits the PDF to CUPS. It must run on a host that can reach the printer. **Eng plays this role today** until a dedicated bot exists; `docs/HANDOFF.md` is written for whoever holds it.

The seam between orchestrator and printer is deliberately dumb: Markdown on stdin, exit code back. Any of the three layers can be replaced without touching the others.

## Section → source map

Defaults proposed; **TBD** means Matt hasn't picked.

| Section | Card presentation | Likely source | Notes |
|---|---|---|---|
| Events | Timeline (time column, dotted spine) | Google Calendar — Matt has a personal calendar connector | Today's events only; all-day events without a time just indent. 4–6 items fit |
| Interesting things to think about | Bullets | **TBD** — Notion saved items, an X pulse, or manual | 3–4 short items; wraps at ~250pt |
| Affirmations | Blank rules | None — handwritten | Orchestrator emits the empty heading; any items would print above the rules |
| Physical health | Checkboxes | matt-trains / Franco coach plan | `- [ ]` per movement or task; up to ~10 fit |
| Journaling / Observations / Thoughts | Notebook ruling | None — morning pages | Always empty; fills the rest of the page (~3.5–4.5") |

## Print path options

Home printers are LAN devices. "Internet connected" Brothers talk to Brother's cloud for firmware and mobile apps; that does not make `ipp://` reachable from outside the house. Every option below keeps the last hop on the LAN. **No paid cloud print SaaS.**

| # | Option | Status | Trade-offs |
|---|---|---|---|
| 1 | **Mac / LAN host with CUPS** — `bun print_brief.ts` runs on Matt's Mac against queue `Brother_HL_L2370DW_series` | **Works today** (first real print done) | Mac must be awake at 06:45; simplest possible setup |
| 2 | **Always-on LAN agent** (Raspberry Pi or similar) with `cups-client`, same queue recreated via `lpadmin … -m everywhere` | Documented in HANDOFF, not set up | Removes the "Mac asleep" failure; needs mDNS (`avahi`) or the printer's IP |
| 3 | **Direct IPP** from the printer bot's host to `ipp://BRWCC6B1E08C933.local.:631/ipp/print` | Only if that host is on the LAN | Same thing CUPS does under the hood; no queue management or retry |

If the printer bot runs off-LAN (a cloud sandbox, Eng's machine elsewhere), put a LAN host on a **Tailscale/VPN** tailnet and either `CUPS_SERVER=<lan-host>` (CUPS shared over the tailnet) or SSH in and run the command there. Tailscale's personal plan is free.

## Morning routine (proposed)

**06:45 PT, Mon–Fri.**

1. Orchestrator asks each source bot for today's fragment (short timeout; a missing fragment becomes an empty section, never a blocked print).
2. Orchestrator assembles the Markdown and hands it to the printer bot.
3. Printer bot optionally runs `--dry-run` and keeps `out/brief-YYYY-MM-DD.{pdf,txt}` as the record of what was sent.
4. Real print once Matt has unlocked it: `cat brief.md | bun print_brief.ts`.
5. **Exit 0 means queued in CUPS, not printed. Do not retry** — an offline printer prints when it wakes; retrying makes duplicates. Exit 2 (empty), 3 (no queue) and 4 (`lp` failed) are the only cases worth a nudge to Matt.

## Template contract

What the printer expects on stdin (the full reference, with per-card syntax, is in `docs/HANDOFF.md`; `examples/sample-brief.md` is a valid instance):

```md
# Daily Brief

## Events
- 09:00 Standup
- 11:30 1:1 with Eng — review the print routine

## Interesting things to think about
- What would this project look like if it were easy?

## Affirmations

## Physical health
- [ ] Easy 5k, zone 2
- [ ] Mobility: hips and thoracic, 10 min

## Journaling / Observations / Thoughts
```

Rules the orchestrator must honour:

- Sections map to cards **by position**, so keep this order. Missing sections are drawn empty with default labels; extra sections are ignored.
- `# Daily Brief` is optional (default title); the date is added automatically.
- Events: a leading `H:MM` (optional `am`/`pm`, optional dash) becomes the time column. Untimed items indent without a dot.
- Physical health: `- [ ] text` (or a plain `- ` bullet) draws a checkbox.
- Affirmations and Journaling stay empty; they are handwriting room.
- Inline `**bold**`, `*italic*`, `` `code` `` and links are flattened to plain text; `---` rules are dropped. Stick to Latin-1 characters plus `•`, dashes and curly quotes.
- Budgets before clipping ("…"): ~6 event lines, ~7 thought lines, ~10 health items.

## Out of scope for this PR

Implementing the bots and orchestrator; merging to `main`; a designed duplex back side; embedding Inter (built-in Helvetica is used; the recipe is in HANDOFF).
