---
name: smoke-tests
description: Use whenever writing or extending smoke tests in the check-local harness — after any migration, database function, pipeline, or enforcement work. Governs what must be proven and how.
---

# Smoke-test patterns

## The harness

`npm run check-local` boots an in-memory Postgres (PGlite), fakes the Supabase auth surroundings, applies all migrations from zero, and runs every smoke test. It is Gate 1: nothing touches live Supabase until it is green. Tests are added to the harness, never run ad hoc against live.

## The refusal rule — the heart of this skill

**Every enforcement gets a refusal test: attempt the forbidden thing, expect the database to throw.** Proving the permitted path works is half a test. The product's promises are refusals, so:

- an unstamped outbound send must throw
- an agent actor attempting to approve must be refused
- an UPDATE or DELETE on `events` or `stage_history` must be refused
- a direct write to `stage_id` must be refused (the stage door)
- a rejection without a reason must be refused

Pattern: **seed → attempt forbidden action → expect throw → assert nothing changed.** The error surfacing from Postgres is the passing result.

## Mandatory coverage per session type

- **New table:** cross-tenant invisibility — a user of business A sees zero rows of business B; plus the no-user-DELETE refusal.
- **New enforcement:** its refusal test (above) AND the permitted path succeeding — both, always.
- **New pipeline function:** happy path, each pre-flight failure mode individually, and the event(s) it must emit via `emitEvent()` actually landing in the ledger.
- **Anything time-dependent:** proven at compressed time through `timeScale()`. A test that waits real time is wrong.

## Hygiene

- Test names state the promise: `"an agent actor cannot approve a communication"`, not `"trigger test 3"`.
- Each test seeds what it needs; no test depends on another test's leftovers.
- A test that was green, then edited, is not green — re-run the whole harness before claiming Gate 1.
