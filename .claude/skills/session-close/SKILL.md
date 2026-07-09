---
name: session-close
description: Use at the end of every session, without exception, to produce the close report and balance the books. A session without a close report did not happen.
---

# Session close

## Bundled files

- `scripts/pre_close_check.mjs` — **run** after the session's final commit,
  before writing the report:
  `node .claude/skills/session-close/scripts/pre_close_check.mjs [--base <ref>] [--decisions-approved "<what approval covers it>"]`
  It performs items 1–3 and 6 of the checklist below by machine: re-runs
  check-local fresh, fails on any dirty or foreign tree state, collects every
  JUDGMENT: mark in the session diff (base defaults to origin/main), and
  fails if docs/DECISIONS.md changed without approval noted. Paste its
  summary block into the report's **State** line. A close report without
  this script's green summary is unverified; items 4–5 remain yours to
  check by hand.

## Before writing the report, verify

1. `npm run check-local` is green **right now** — run it fresh; a stale green is a red.
2. Nothing outside the session's scope block was modified. `git status` and the diff confirm it.
3. Every `JUDGMENT:` comment written this session is collected for the report — grep for them; memory doesn't count.
4. Any new enforcement built this session is noted for addition to `docs/PLAYBOOK.md` §7 (protected structures).
5. Any item that must be true before real leads flow is already in `docs/GO-LIVE.md` — not "will add it".
6. `docs/DECISIONS.md` was NOT written this session unless Mudassir approved a call mid-session.

## The report (PLAYBOOK Appendix B)

```
## Session N — close report

**Delivered** (each with its proof):
1. <thing> — proven by <smoke test name / click path>.

**Judgment calls awaiting your sign-off** (Lane B; JUDGMENT: comments at each site):
1. <call> — <one-line rationale>. Recommend: <approve/alternative>.

**GO-LIVE additions:**
- <item, or "none">

**What I need from you:**
- <sign-offs, click-review URL + path, credentials, merge>

**State:** check-local <green, N tests> · live Supabase <applied/untouched> ·
branch <name/none> · nothing outside the above was modified.
```

## Rules of the report

- Nothing delivered that isn't listed; nothing listed that isn't proven. "Implemented X" is not a proof — a named smoke test or a click path is.
- If the session failed or split, say so plainly: what stands, what doesn't, what the follow-up session needs. A truthful partial report beats a rounded-up complete one.
- "What I need from you" must be actionable verbatim — Mudassir should be able to do each item without asking a clarifying question.
