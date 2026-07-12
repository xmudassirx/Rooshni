---
name: preview-verification
description: Use for every UI session — building screens, changing layout, theming. Governs branching, Vercel previews, and the click-review handover to Mudassir. UI never merges without his click-review.
---

# Preview verification

## Branch and deploy

1. All UI work on a branch named `ui/session-N-<slug>` (e.g. `ui/session-4-shell`). Never on main.
2. Push the branch; Vercel produces a preview deployment. The preview URL is the deliverable — code that isn't clickable doesn't exist for review purposes. Branch aliases follow `rooshni-web-git-<branch>-…` — the project segment is `rooshni-web`, not `rooshni` (founder correction, Session 6 close). Copy the URL from the Vercel deployment, never compose it by hand.
3. **You never merge.** Mudassir's click-review is the merge gate, and he performs the merge.

## Fidelity rules before handover

- Every screen must match its **approved mockup** (`docs/` mockup files and signed design amendments). Structure deviating from the mockup is Lane C — ask before building it, not after.
- **Semantic colour invariants hold on every screen and theme: gold = Light acted, red = human stamp, green = done; the monospace register face never changes.** Check these explicitly before handover.
- Both themes (Ledger — the shipping default — and Frost) render correctly; a screen approved in one theme and broken in the other is not done.
- Live data where the session scope says live data; no lorem-ipsum standing in for wired states without saying so.

## The handover checklist

The founder decides by clicking. Hand over exactly this, per screen:

```
Preview: <URL>
Click path: <from login/landing, step by step, to the thing being reviewed>
Expected: <what he should see happen, including states — empty, error, loading>
Matches: <which approved mockup screen / signed amendment this implements>
Known gaps: <anything intentionally deferred, with its session or GO-LIVE reference>
```

Never hand over a bare URL. If he has to hunt for what changed, the handover failed.

## Bundled files

- `resources/handover-template.md` — **copy and fill** for every handover,
  one Screen block per changed screen, pre-handover checkboxes ticked before
  sending; paste the completed file into the close report. Do not compose
  handovers freehand — the template is the checklist.

## After review

- Fix requests before merge are part of this session, on the same branch, re-previewed.
- Design decisions he makes during click-review are relayed to Build Ops and recorded (docs/DECISIONS.md after approval); they are not silently absorbed.
