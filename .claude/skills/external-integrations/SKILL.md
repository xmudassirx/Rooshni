---
name: external-integrations
description: Use for any work touching an external service — Meta (Lead Ads, WhatsApp, Conversions), Microsoft Graph (email/calendar), Trigger.dev, Stripe, or any new provider. Governs webhook contracts, credentials and secret hygiene, idempotency, API versions, and the two-session rule.
---

# External integrations

## The two-session rule (PLAYBOOK §6.3)

Every integration is two sessions, never one:

1. **Contract session:** the webhook/API payload shape captured as seeded fixtures matching the provider's real documented format *exactly* (the Session 1 Meta Lead Ads payloads are the pattern); the handler built and smoke-tested against those fixtures; signature verification and idempotency proven — all without a single live credential.
2. **Wiring session:** credentials in, real endpoint registered, ONE real event proven end to end, its ledger events shown.

If you are in a contract session and feel the pull to "just test it live" — that is Lane C. Stop.

## Non-negotiables

- **Integrations never bypass the gates.** An inbound webhook may create contacts, engagements, tasks — it may NEVER move a communication to approved/sent, publish, or approve anything. The human-stamp triggers (PLAYBOOK §7) apply to integration code identically. Outbound sends triggered by workflows still pass through the approval pipeline.
- **Idempotency on the provider's id.** Every inbound event carries an external id (Meta lead id, Graph message id). Processing is keyed on it; replaying the same event twice changes nothing and is smoke-tested as a refusal ("duplicate webhook creates no second contact").
- **Verify signatures before trusting payloads.** Meta: `X-Hub-Signature-256` HMAC check. Reject on mismatch, event the rejection. An unverified webhook body is untrusted input, always.
- **Everything evented.** Every inbound event and every outbound external call that mutates anything writes to the ledger via `emitEvent()` — the events ledger is Light's nervous system and the audit trail; a silent integration is a broken one.
- **Pin API versions.** Meta Marketing API v25+ per the kickoff brief; version strings live in config, not scattered in call sites. A provider version bump is a deliberate change, never an accident.
- **External calls fail; plan for it.** Explicit timeouts, explicit retry policy, and a dead-letter path that raises a visible item — never a swallowed exception. Time-based retry behaviour is tested through `timeScale()`.
- **Provider-agnostic seams where the spec says so.** Email/calendar go through the connector interface (Microsoft Graph now, Google Workspace Phase 2) — no Graph-specific types leaking above the connector boundary.

## Secret and config hygiene (absorbed rule set)

- Credentials come from Mudassir on request, never discovered, never guessed, never read from outside the repo (CLAUDE.md law 1).
- Secrets live in `.env.local` (git-ignored — verify, don't assume) locally and in Vercel env vars for deployments. Never in code, never in migrations, never in fixtures, never in logs or error messages — including debug output you delete later.
- `.env.example` is updated with the variable NAME (never the value) in the same session that introduces it.
- Every new secret adds a GO-LIVE item at introduction: where it lives, what it grants, its expiry/rotation date (e.g. the Azure client secret's 730-day expiry).
- Webhook verify tokens and signing secrets are secrets. Treat them as above.

## Wiring-session checklist

1. Env vars named, requested from Mudassir, placed (.env.local + Vercel), `.env.example` updated.
2. Endpoint registered with the provider (or Mudassir does it in their console — give exact click-path instructions).
3. One real event traced end to end: provider → handler → rows created → ledger events, each shown in the close report.
4. Failure path demonstrated once (bad signature rejected and evented).
5. GO-LIVE items added: secret rotation, any provider review-queue dependencies, rate-limit notes.
