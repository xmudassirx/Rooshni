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

/**
 * Session 10 — the send-pipeline and Meta-inbound vocabulary. Same JUDGMENT
 * as above: kinds are TS constants, the single truth every emitter imports
 * (decision 89d — no kind registry exists in schema; inventing one would be
 * improvised schema).
 */
export const SEND_EVENT_KINDS = {
  /** A stamped message left the building — provider + provider message id in the payload. */
  communicationSent: "communication.sent",
  /** The provider REFUSED the message — a visible failure, never a silent drop. */
  communicationSendFailed: "communication.send_failed",
  /** Stamped inside quiet hours — held, dispatching at the window's end. The stamp is the founder's; the timing is policy. */
  communicationQueuedQuietHours: "communication.queued_quiet_hours",
  /** A real Meta lead arrived through the webhook (idempotent on the leadgen id). */
  metaLeadReceived: "meta.lead_received",
  /** Decision 15: the auto-close step refused to close — its nudges never reached the client. */
  workflowAutoCloseRefused: "workflow.auto_close_refused",
} as const satisfies Record<string, EventAction>;

export type OnboardingEventKind = (typeof EVENT_KINDS)[keyof typeof EVENT_KINDS];
