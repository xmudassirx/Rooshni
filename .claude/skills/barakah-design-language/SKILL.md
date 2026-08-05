---
name: barakah-design-language
description: Use when designing, building or critiquing any visual surface — product chrome in apps/web or marketing pages in apps/marketing — choosing colours, faces, radii, spacing, shadows, or judging a screen against the design language. Do NOT use for animation or transition questions (that is barakah-motion), or for theme-engine implementation mechanics like Tailwind bridging and shadcn conventions (that is ui-system).
---

# Barakah design language

The design language exists so a screenshot of any surface can be read for
WHO ACTED by colour alone; faces, radii and spacing serve that legibility.
This skill routes to two authoritative companion files — quote them, never
improvise around them.

## SETUP — do these, in order, before any design work

1. **MUST read `TOKENS.md`** (this folder) in full — the extracted token
   tables with real values, each row carrying its WHY and its decision
   number. Do not work from memory of it.
2. **MUST read `BANS.md`** (this folder) — the match-and-refuse register.
   You will re-check your own diff against it before handover.
3. **MUST read at least one real file of the surface in focus** before
   proposing anything: product work → `apps/web/app/globals.css` plus the
   component or page file being touched; marketing work →
   `apps/marketing/app/globals.css` plus the page file. The mockup shows
   intent; the live file shows what ships.
4. **MUST determine the register and state it** in your first response:
   - **PRODUCT chrome** (`apps/web`) — design serves the work. Bound by:
     the full token vocabulary, the colour taxonomy law, the three-theme
     system, the register face, the BARAKAH TEST, every BANS.md row.
   - **MARKETING** (`apps/marketing`) — design is the argument. Bound by:
     its own lighter system (TOKENS.md marketing table), the quoted-
     taxonomy rule (product colours only inside product depictions, gold
     never chrome), BANS.md rows 5–9 — NOT the product theme system.

## INSTRUCTIONS — the constraints

- **Quote the token table, never invent a value.** Every colour, radius,
  spacing step and shadow must be traceable to a TOKENS.md row (or the
  live CSS read in setup). A missing value is a gap to flag, not a licence
  to pick a hex.
- **The companion file is authoritative — where it and your instinct
  disagree, the file wins.** Your taste is not a source.
- **Check every element against BANS.md before handover.** A match means
  the element is rewritten, not defended.
- **Conflicts are recorded, never resolved.** If mockup, live CSS and
  amendments disagree beyond what TOKENS.md records, flag a `JUDGMENT:`
  mark under the judgment lanes — never pick silently.
- **British English in every user-facing string.** Invariants hold on
  every screen, in every theme: gold = Light acted, red = human stamp,
  green = done; the monospace register face never changes.
- **Close every design review with the BARAKAH TEST** (TOKENS.md, final
  section) — a beautiful screen that fails it is a failed screen.

## ROUTING

| Need | Go to |
|---|---|
| A colour, face, radius, spacing or shadow value | `TOKENS.md` |
| "May I write this element at all?" | `BANS.md` |
| Animation, transitions, anything that moves | `barakah-motion` skill |
| Tailwind bridge, shadcn primitives, theme code · UI handover | `ui-system` · `preview-verification` skills |

## WORKED EXAMPLES

**1. "Build the Campaigns list screen" (product register).**
Correct output narrates token selection from TOKENS.md before any code:
"Register: PRODUCT chrome. Panel: `.glass`, radius 12px (18px in Frost);
header in the register face — 10.5px mono, .14em tracking, uppercase,
`--ink-soft`. Badges: Sent = green (done-semantics), ✦ Pending stamp =
gold chip (Light acted), Scheduled = ink (neither). Active filter pills
take `--accent` — chrome follows the user's accent, decision 61. Row
title 14px/700, metadata 12.5px `--ink-soft`." Only then the component.

**2. "Critique this screen" (a mocked contacts table).**
Correct output: a findings table, each row anchored, then the verdict:

| Element | Finding | Anchor |
|---|---|---|
| "Synced ✓" chip in green on every row | Unearned tick — no sync check ran; and green used as chrome | BANS 1; decision 61 |
| Tag chip `overdue` | Machine-knowable state as a tag — render as a derived chip, tags are human judgment | BANS 2 |
| Row checkbox with no bulk action | Dead control — remove until its pipeline exists | BANS 3 (decision 116) |
| Header in Bitter in Frost | Frost display face is Public Sans — quote TOKENS.md themes table | TOKENS.md |

Verdict: fails the BARAKAH TEST — green reads as decoration, so "done" is
no longer legible.

**3. "Make us a pricing page" (marketing register).**
Correct output states the register first: "Register: MARKETING —
`apps/marketing`, its own lighter system. Headlines in the serif, weight
500, `clamp` scale; page on `--paper #fcfbf8`; buttons ink-on-paper,
radius 0.25rem. The product's gold/red/green appear ONLY inside product
depictions (e.g. a Record fragment) — quoted hexes from the marketing
table, and gold is never chrome even here; no prism outside a depiction.
Fees here are marketing's own copy, but any depicted product chrome must
not show fees in chrome (BANS 9)."

**4. "Add a gold accent to the Approve button — it looks premium."**
Correct output refuses with the anchor: "No — gold is Light's channel
(decision 61, BANS 6); Approve is the human stamp and wears `--stamp` red.
Premium is not a colour we have; the accent is the only user-flavoured
chrome."
