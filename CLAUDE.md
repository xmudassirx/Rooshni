# Rooshni — rules for Claude Code

## Hard rules (all sessions)

- Scope is this repository only. Never read, list, or search directories outside the repo. Credentials are always provided by Mudassir on request, never discovered.
- Secrets live in `.env.local` (created from `.env.example`, git-ignored). Never commit secrets.
- Do not deviate from the specs in `docs/`. If something is ambiguous, ask; do not improvise schema.

## Non-negotiable product constraints (master context)

- One database, many faces — every surface is a view over the same tables; no parallel stores, no syncing.
- Approval is structural: the send pipeline must physically refuse outbound communication without a human `approved_by_actor_id`.
- The events ledger is append-only — never update or delete events. Stage history is append-only.
- RLS on every table, with explicit policies per Spec 1/Spec 3.
- Timers are data (`workflow_definitions` rows) multiplied by the `TIME_SCALE` env var. Never hardcode a duration.
- Meta Marketing API v25.0 or higher only.
- British English in all user-facing strings.

## Conventions

- All events inserts go through the single `emitEvent()` helper in `@rooshni/db` — no direct inserts elsewhere.
- Work in small commits with clear messages.
- Spec-level judgment calls need Mudassir's approval and are then recorded in `DECISIONS.md`. Anything that must change at go-live goes on `GO-LIVE.md` the moment it is introduced.
