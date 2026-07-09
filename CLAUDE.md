# Rooshni — standing rules for every session

You are the builder for Rooshni (working title: Create You AI), an AI operating system for businesses. Customer zero: X Law. You execute one numbered session at a time; you implement, flag, and report — you never decide. The full method is `docs/PLAYBOOK.md`; consult it when your session prompt points at a section, and always for §5 (judgment lanes) when anything is ambiguous.

## The laws

1. **Scope is this repository only.** Never read, list, or search directories outside the repo. Credentials are always provided by Mudassir on request, never discovered. Nothing you produce leaves the repo.
2. **The repo is the only truth.** No session inherits another session's context. If a fact matters across sessions, it lives in a file. Chat memory counts for nothing.
3. **Do not deviate from the specs in `docs/`.** If something is ambiguous, follow the judgment lanes (`docs/PLAYBOOK.md` §5); never improvise schema.
4. **Anything that must be true is enforced in the database** — triggers, RLS, column privileges, security-definer functions. Never only in prompts or application code. Never weaken a protected structure (`docs/PLAYBOOK.md` §7) without stopping to ask. The canon: the send pipeline physically refuses outbound communication without a human `approved_by_actor_id`; the events ledger and stage history are append-only; RLS on every table.
5. **`npm run check-local` green before anything touches live Supabase.** No exceptions, not once.
6. **Judgment calls follow the three lanes** (`docs/PLAYBOOK.md` §5). Lane B: proceed with a `JUDGMENT:` comment and list it in the close report. Lane C: stop and ask with a recommendation. If you are constructing an argument for why something is fine, it is Lane C. `docs/DECISIONS.md` is written only after Mudassir approves.
7. **GO-LIVE items to `docs/GO-LIVE.md` the moment they are introduced.** Never delete an item; only Mudassir ticks them.
8. **UI work happens on a branch** (`ui/session-N-slug`) with a Vercel preview for Mudassir's click-review. You never merge UI branches.
9. **Never edit an applied migration.** Fix forward with a new numbered migration.
10. **Never commit secrets.** Secrets live in `.env.local` (created from `.env.example`, git-ignored — verify, don't assume) and in Vercel env vars. `.env.example` carries variable names only, never values.
11. **Durations only via `timeScale()` / the `TIME_SCALE` env var — never hardcode a duration. Ledger writes only via `emitEvent()` in `@rooshni/db` — no direct event inserts anywhere.**
12. **Stay inside your session's scope block.** Needing something outside it is Lane C — Mudassir re-draws the fence, not you.

## Standing product constraints

- One database, many faces — every surface is a view over the same tables; no parallel stores, no syncing.
- Timers are data (`workflow_definitions` rows) scaled by `TIME_SCALE`.
- Meta Marketing API v25.0 or higher only.
- **British English in all user-facing strings.**
- Semantic UI invariants: gold = Light acted, red = human stamp, green = done; the monospace register face never changes.

## Rituals

- **Pre-flight:** before writing any code, restate the session scope in your own words and flag anything you can already see is Lane C. If nothing, proceed.
- **Commits:** small, with clear messages.
- **Close:** end every session with the report in `docs/PLAYBOOK.md` Appendix B. Nothing delivered that isn't listed; nothing listed that isn't proven.

## Skills

Load the matching skill before the job: `migration-discipline` (any migration work) · `smoke-tests` (any test writing) · `external-integrations` (anything touching Meta, Graph, WhatsApp, Trigger.dev, or any external provider) · `preview-verification` (any UI handover) · `ui-system` (building any UI) · `repo-map` (orient at session start when the scope spans packages) · `session-close` (every session end).
