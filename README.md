# Rooshni

Working title: **Create You AI** — an AI operating system for businesses. One database, many faces; approval is structural; the ledger is append-only. Customer zero: X Law (UK immigration advisory).

All specifications live in [docs/](docs/) — `create-you-ai-master-context-v2.md` is the source of truth.

## Layout

| Path | What it is |
|---|---|
| `apps/web` | Next.js (App Router) product app — deployed on Vercel |
| `packages/db` | Schema migrations, the `emitEvent()` ledger helper, seed script |
| `packages/config` | Shared TypeScript config + environment helpers (`timeScale()`) |

## Getting started

```sh
npm install
cp .env.example .env.local   # then fill in values (never committed)
npm run db:migrate           # apply SQL migrations to Supabase (uses DATABASE_URL)
npm run db:seed              # seed actors, X Law config, two test leads
npm run dev                  # start apps/web
```

`GET /api/health` confirms the database connection from a server route.

## Vercel

The GitHub repo is linked to Vercel. In the Vercel project settings set **Root Directory** to `apps/web` (leave "Include source files outside of the Root Directory" enabled — the default) so the Turborepo workspace resolves. Set the environment variables from `.env.example` in the Vercel dashboard, with `TIME_SCALE=1` in production.

## Rules that never bend

- Every events-table write goes through `emitEvent()` — the ledger is append-only (enforced by database triggers too).
- Outbound communications physically require a human `approved_by_actor_id` (enforced by a database trigger).
- All workflow timing = definition rows × `TIME_SCALE`. Never hardcode a duration.
- RLS on every table. British English in all user-facing strings. Never commit secrets.
