import type { EventAction } from "./types";

/**
 * Session 9 — the onboarding ledger vocabulary, declared in one place.
 *
 * JUDGMENT: the session scope lists these under "migrations", but no event
 * kind registry exists in the schema (events.action is shape-checked free
 * text, Spec 1 §5.2) — inventing a registry table would be improvised
 * schema, so the kinds are declared here, the single TS truth every emitter
 * imports. The crawl and memory kinds are RESERVED now, emitted by the
 * crawler session (crawl.*, memory.proposals_raised) and the First Light
 * session (first_light.completed) — this session emits only the account and
 * payment kinds.
 *
 * account.* is the one namespace lawful at PLATFORM scope (events with a
 * null business_id, 0020 check constraint) — a deleted unpaid signup has no
 * business to charge the event to.
 */
export const EVENT_KINDS = {
  accountCreated: "account.created",
  accountDeletedUnpaid: "account.deleted_unpaid",
  paymentSucceeded: "payment.succeeded",
  crawlStarted: "crawl.started",
  crawlFinished: "crawl.finished",
  memoryProposalsRaised: "memory.proposals_raised",
  firstLightCompleted: "first_light.completed",
} as const satisfies Record<string, EventAction>;

export type OnboardingEventKind = (typeof EVENT_KINDS)[keyof typeof EVENT_KINDS];
