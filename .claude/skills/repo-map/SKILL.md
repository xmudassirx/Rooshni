---
name: repo-map
description: Use to orient at session start, especially when the scope spans packages — the monorepo map, what each package owns, and where truth for each concern lives. Regenerate whenever repo structure changes.
---

# Repo map

Turborepo monorepo, npm workspaces (`apps/*`, `packages/*`), Node ≥ 20. Root scripts (`package.json`): `build` / `dev` / `lint` / `typecheck` via turbo; `db:migrate` and `db:seed` alias into `@rooshni/db`. The check-local harness runs with `npm run check-local --workspace=@rooshni/db`.

## The packages

### `packages/db` — `@rooshni/db`. The database is the product's law; this package is its home.
- `migrations/` — numbered, forward-only SQL, `0001`–`0018` so far. Schema, RLS, triggers, privileges, pipeline functions. An applied migration is never edited.
- `src/` — the TypeScript surface: `events.ts` (`emitEvent()`, the single ledger write path), `approvals.ts` (submit/approve/reject helpers that call the pipeline RPCs then event via `emitEvent()`), `client.ts` (Supabase client factories), `types.ts`.
- `scripts/` — `check-local.ts` (Gate 1: PGlite in-memory Postgres, fakes the Supabase auth surroundings, applies all migrations from zero, runs every smoke test — the smoke tests live inside this file), `migrate.ts` (live apply), `verify.ts` (live inspection), `env.ts`.
- `seed/` — `index.ts` (idempotent, deterministic ids; demo data is on the docs/GO-LIVE.md purge list), `fixtures/meta-leads.ts` (provider-exact Meta Lead Ads payloads — the contract-session pattern).

### `apps/web` — the Next.js product app (App Router, React 19, Tailwind v4, shadcn/ui). Deployed on Vercel (root directory `apps/web`).
- `middleware.ts` — session + `allowed_emails` gate on every app route; outsiders get the holding page as a rewrite.
- `app/(app)/` — the signed-in app: shell layout, dashboard, inbox (Approval Inbox), enquiries, conversations, contacts, automation, notes, memory, record, settings. Several are placeholders awaiting their sessions.
- `app/auth/` (OAuth callback, signout), `app/signin/`, `app/construction/` (the nameless public holding page).
- `lib/server/context.ts` — `getAppContext()`: the user-scoped, RLS-bound entry point every server component uses. `lib/server/queries.ts` — read queries. `lib/supabase/` — server/browser client factories.
- `app/globals.css` + `app/layout.tsx` — the entire theme/token system and fonts (see the `ui-system` skill).

### `packages/config` — `@rooshni/config`
- `src/index.ts` — `timeScale()` / `scaleDurationMs()` (the only lawful way to handle durations; reads `TIME_SCALE`), `requireEnv()`.
- `typescript/base.json` — shared tsconfig.

## Where truth lives, per concern

| Concern | Truth |
|---|---|
| Schema & enforcement (triggers, RLS, privileges) | `packages/db/migrations/` — RLS baseline `0012`, grants `0013`, permissions engine `0014`–`0015`, stage door `0016`, approval door + pre-flight `0017`, allowlist `0018` |
| Ledger write path | `packages/db/src/events.ts` (`emitEvent()`) |
| Approval pipeline | SQL: `migrations/0017_approval_inbox.sql`; TS helpers: `packages/db/src/approvals.ts`; UI: `apps/web/app/(app)/inbox/` |
| Timers | `packages/config/src/index.ts` + `TIME_SCALE` env var (`workflow_definitions` arrives with Spec 4 — not yet built) |
| Themes & design tokens | `apps/web/app/globals.css` (see `ui-system`) |
| Seeds & provider fixtures | `packages/db/seed/` |
| Tests | `packages/db/scripts/check-local.ts` (the harness IS the test suite) |
| Specs | `docs/phase0-spec1..4-*.md`, `docs/create-you-ai-master-context-v2.md` |
| Design authority | `docs/mockup-pass1-shell-pipeline-case.html` + signed amendments (listed in `ui-system`) |
| Decisions / go-live | `docs/DECISIONS.md` · `docs/GO-LIVE.md` |
| Env vars | root `.env.example` (names only) → `.env.local` (git-ignored); `apps/web/next.config.ts` loads the repo-root file in dev |

## What to read first, per kind of work

- **Schema / migration work:** the `migration-discipline` skill → the relevant spec section → the highest-numbered migration (for current conventions) → `scripts/check-local.ts` (where your refusal tests go).
- **Database functions / pipelines:** `migrations/0016`–`0017` (the pipeline-function pattern: security definer, `assert_pipeline_caller`, privileges revoked from public) → `src/approvals.ts` (the TS wrapper pattern).
- **UI:** the `ui-system` skill → `preview-verification` → the mockup → `lib/server/context.ts` for data access.
- **External integrations:** the `external-integrations` skill → `seed/fixtures/meta-leads.ts` (the contract pattern).
- **Tests:** the `smoke-tests` skill → `scripts/check-local.ts`.
