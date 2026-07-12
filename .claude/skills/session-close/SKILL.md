---
name: session-close
description: Use at the end of every session, without exception, to produce the close report and balance the books. A session without a close report did not happen.
---

# Session close

## Bundled files

- `scripts/pre_close_check.mjs` — **run** after the session's final commit,
  before writing the report:
  `node .claude/skills/session-close/scripts/pre_close_check.mjs [--base <ref>] [--decisions-approved "<what approval covers it>"] [--allow-dirty "<path>: <reason>"]...`
  It performs items 1–3 and 6 of the checklist below by machine: re-runs
  check-local fresh, fails on any dirty or foreign tree state, collects every
  JUDGMENT: mark in the session diff, and fails if docs/DECISIONS.md changed
  without approval noted. Paste its summary block into the report's **State**
  line. A close report without this script's green summary is unverified;
  items 4–5 and 7 remain yours to check by hand.
  - `--base` — **always pass the `origin/main` SHA recorded at pre-flight**
    (PLAYBOOK §3.2). The default `origin/main` is only correct if nothing
    landed on the remote mid-session; the recorded SHA is correct always.
  - `--allow-dirty "<path>: <reason>"` (repeatable) — a founder-declared
    expected-dirty path from the session prompt. The path may be dirty or
    untracked; path and reason echo into the summary block. ANY undeclared
    dirty state still fails; no flag, no exception. Never declare a path the
    session prompt did not.

## Before writing the report, verify

1. `npm run check-local` is green **right now** — run it fresh; a stale green is a red.
2. Nothing outside the session's scope block was modified. `git status` and the diff confirm it.
3. Every `JUDGMENT:` comment written this session is collected for the report — grep for them; memory doesn't count.
4. Any new enforcement built this session is noted for addition to `docs/PLAYBOOK.md` §7 (protected structures).
5. Any item that must be true before real leads flow is already in `docs/GO-LIVE.md` — not "will add it".
6. `docs/DECISIONS.md` was NOT written this session unless Mudassir approved a call mid-session.
7. The session's own line is appended to `docs/SESSIONS.md` (number · date · one-sentence scope · landing SHA(s) · close status) **in the session's final commit** — the ledger append is part of the close, not a promise. Landing SHAs name the session's content commits; the close commit carrying the line is identified by `branch @ head` in the pre-close summary.

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
