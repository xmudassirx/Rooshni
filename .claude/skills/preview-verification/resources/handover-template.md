# Click-review handover — Session N: <slug>

<!--
Fill one "Screen" block per screen changed this session and paste the whole
file into the close report. Every field is mandatory — "n/a" is written out,
never implied by omission. Never hand over a bare URL: if Mudassir has to
hunt for what changed, the handover failed.
-->

**Branch:** `ui/session-N-<slug>`
**Preview:** <Vercel preview URL>

## Pre-handover checks (all must be ticked before this file is sent)

- [ ] Every screen matches its approved mockup (`docs/` mockups + signed
      amendments); any structural deviation was a Lane C stop BEFORE building.
- [ ] Semantic colour invariants hold on every screen: gold = Light acted,
      red = human stamp, green = done; the monospace register face unchanged.
- [ ] Both themes render correctly — Ledger (shipping default) AND Frost.
- [ ] All user-facing strings are British English.
- [ ] Live data wherever the scope says live data; any stand-in states are
      declared under "Known gaps", not left to be discovered.

## Screen: <name>

- **Click path:** <from sign-in/landing, step by step, to the thing under review>
- **Expected:** <what he should see happen — including empty, error and
  loading states where they exist>
- **Matches:** <which approved mockup screen / signed design amendment this
  implements>
- **Known gaps:** <anything intentionally deferred, with its session number
  or GO-LIVE reference — or "none">

## Screen: <name>

- **Click path:** …
- **Expected:** …
- **Matches:** …
- **Known gaps:** …

## After review

Fix requests land on this same branch and are re-previewed under this same
checklist. Design decisions made during click-review are relayed to Build
Ops and recorded in docs/DECISIONS.md after approval — never silently
absorbed. The founder merges; the builder never does.
