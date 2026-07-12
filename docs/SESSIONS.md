# Session ledger

One line per session: **number · date · one-sentence scope · landing SHA(s) · close status.**
Appending the session's own line is part of every close (PLAYBOOK §3.2 step 8, §8; session-close
skill item 7). Landing SHAs name the session's content commits, oldest…newest; the close commit
carrying a session's own ledger line is named in its close report.

Entries marked **®** are reconstructed backfill, written at Session 7 and verified against git
history and `docs/DECISIONS.md` only — dates are commit dates, sign-off dates per DECISIONS
headers where they differ. Commit `c077223` (Phase 0 specs, master context, mockup) predates
Session 1 — a founder commit, no session. The two method sessions of 9 July 2026 predate the
numbering of method work and carry no number.

<!-- JUDGMENT: ledger format fills beyond the ruled columns — the ® reconstruction marker,
     unnumbered rows for the two pre-ledger method sessions, and first…last SHA spans — are
     Lane B; the ruling named the columns only. -->
<!-- JUDGMENT: this session takes number 7, read from the backfill — sessions 1–6 verified
     numbered in DECISIONS.md, the method sessions verified unnumbered; the prompt left N
     symbolic by design. -->

| # | Date | Scope | Landing SHA(s) | Close |
|---|------|-------|----------------|-------|
| 1 | 8 Jul 2026 | Spec 1 schema — monorepo scaffold, six primitives, RLS + structural gates, seed, live apply | `abeabe9`…`48a3155` | closed; signed (DECISIONS 1–5) ® |
| 2 | 8 Jul 2026 | Spec 3 permissions engine — levels as data, tool registry, grants, gated stage moves | `b080b89`…`11c18ef` | closed; signed (DECISIONS 6–15) ® |
| 3 | 8 Jul 2026 | The Approval Inbox — view over pending states, readiness pre-flight, closed approve/reject pipeline | `3d1fcb3`…`bba87e6` | closed; signed (DECISIONS 16–22) ® |
| 4 | 8–9 Jul 2026 | First UI slice — Tailwind/shadcn foundation, app shell, Enquiries pipeline, Approval Inbox UI | `5dc857b`…`436833b` | closed; signed (DECISIONS 23, since retired) ® |
| 5 | 9 Jul 2026 | Authentication — allowlist door, Google sign-in, middleware gate, production sign-out/OAuth fixes | `544d826`…`734c272` | closed; signed (DECISIONS 24–28) ® |
| — | 9 Jul 2026 | Method: playbook v1.0 install + verification close-out (incident 1) | `99bd2f2`…`35a24b0` | closed; signed (DECISIONS 29–31) ® |
| 6 | 9 Jul 2026 (signed 12 Jul) | Spec 4 workflow engine — definition door, run state machine, MVP workflow as data, tick entry points | `99d9a74`…`77e69ba`; near-miss log `5ee4178` | closed; signed (DECISIONS 37–56) ® |
| — | 9 Jul 2026 | Method: skill hardening, incident-2 tightening — ran in its own granted worktree | `7bbe683`…`8b03faa` | closed; signed (DECISIONS 32–36) ® |
