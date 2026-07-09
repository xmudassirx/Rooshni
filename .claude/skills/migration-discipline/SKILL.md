---
name: migration-discipline
description: Use whenever creating, ordering, or applying database migrations in packages/db — schema changes, RLS policies, triggers, privileges, seeds. Governs how migrations are written, tested, and applied to live Supabase.
---

# Migration discipline

## Non-negotiables

1. **Numbered, forward-only.** New work = new migration with the next number. An applied migration is NEVER edited — fix forward with another migration, even for your own mistake from an hour ago.
2. **check-local before live.** `npm run check-local` must apply ALL migrations from zero and pass ALL smoke tests before anything is applied to live Supabase. If check-local passes but you haven't run it since your last edit, it hasn't passed.
3. **Every new table, in the same migration, gets:**
   - UUIDv7 primary key
   - the envelope columns per Spec 1
   - RLS enabled with explicit business-membership policies
   - NO DELETE policy for users (hard delete is Level 3+ service-role only)
4. **Enforcement travels with the table.** If the spec says append-only, the UPDATE/DELETE-blocking trigger ships in the same migration as the table. If a column must not be written directly, the privilege revocation and the security-definer door function ship together. A table without its enforcement is an unfinished migration, not a first step.
5. **Protected structures** (PLAYBOOK §7) are never weakened, special-cased, or "temporarily" disabled by a migration. That is Lane C: stop and ask.

## Judgment marks

Every Lane B call gets a comment at the site, in the migration itself:

```sql
-- JUDGMENT: spec column name `order` is a reserved keyword; using sort_order.
```

Collect all JUDGMENT marks in the session close report. None enters docs/DECISIONS.md until Mudassir approves.

## Bundled files

- `resources/migration-template.sql` — **read and copy** when creating any
  new-table migration, before writing DDL freehand: it carries the Spec 1
  envelope, the RLS policy block, the no-user-DELETE rule and the JUDGMENT
  mark form, so none is reinvented from memory.
- `scripts/check_migration.mjs` — **run** on every migration you write,
  before committing it:
  `node .claude/skills/migration-discipline/scripts/check_migration.mjs <file.sql>`
  (no arguments = lint every migration in `packages/db/migrations`). It
  checks RLS-per-table, user DELETE policies, JUDGMENT mark form, and — via
  git — that no previously committed migration was edited. It reports and
  never fixes; a finding is fixed forward, by you.

## Seeds

- Seeds are idempotent — keyed on an external id (e.g. the Meta lead id), safe to run twice.
- Seeded external payloads match the provider's real format exactly (the Session 1 Meta Lead Ads payloads are the pattern), so the later live-wiring session verifies against something true.

## Live apply

- Apply to live only after check-local is green, and report exactly what was applied.
- Destructive operations against live data (DELETE, TRUNCATE, destructive ALTER) are Lane C — stop and ask, always.
