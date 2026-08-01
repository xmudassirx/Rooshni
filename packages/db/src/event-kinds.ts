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
  /** Platform scope (account.*): the account's allowlist row was archived —
   * the sign-in door closed, reversibly; the row itself keeps the record.
   * No personal data in the payload (the nurture_unsubscribed precedent). */
  accountAllowlistArchived: "account.allowlist_archived",
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

/**
 * Session 11 — First Light and template installation. Same JUDGMENT as
 * above: kinds are TS constants, the single truth every emitter imports.
 * first_light.completed already lives in EVENT_KINDS (reserved by Session 9,
 * emitted by this session).
 */
export const FIRST_LIGHT_EVENT_KINDS = {
  /** A vertical template's rows were installed for a business at activation. */
  templateInstalled: "template.installed",
  /** A First Light predicate EARNED its tick — paired to the row flip by the 0020 constraint. */
  predicateSatisfied: "first_light.predicate_satisfied",
  /** An OPTIONAL First Light row was skipped by the owner, with the stated reason. */
  rowSkipped: "first_light.row_skipped",
  /** A Settings → General value was confirmed or corrected by a human (the propose→stamp loop). */
  settingsUpdated: "settings.updated",
  /** Platform scope (account.*): a pre-active signup opted out of nurture mail. No personal data in the payload. */
  accountNurtureUnsubscribed: "account.nurture_unsubscribed",
  /** Session 13 fix round: a basics row was explicitly marked not applicable — an addressed row, never a silent confirm. */
  basicsRowNotApplicable: "first_light.basics_not_applicable",
  /** Session 13 fix round: a previously recorded tick was struck — unearned, with the stated reason; the row returns to open. */
  predicateUnearned: "first_light.predicate_unearned",
} as const satisfies Record<string, EventAction>;

/**
 * Session 15 — query-aware drafting. Same JUDGMENT as above: kinds are TS
 * constants, the single truth every emitter imports.
 */
export const DRAFTING_EVENT_KINDS = {
  /** A knowledge-pack entry was created (content_items, PR-1). */
  knowledgeEntryCreated: "knowledge.entry_created",
  /** A knowledge-pack entry's body/category changed — a new content_version rides along. */
  knowledgeEntryUpdated: "knowledge.entry_updated",
  /** A knowledge-pack entry became what retrieval reads (human publisher, approvals.content). */
  knowledgeEntryPublished: "knowledge.entry_published",
  /** A knowledge-pack entry left service (soft archive — never deleted). */
  knowledgeEntryArchived: "knowledge.entry_archived",
  /** PR-2 backfill: a shadow-era enquiry received its form answers from the stored leadgen id. */
  formAnswersBackfilled: "engagement.form_answers_backfilled",
  /** Light composed a draft — the credit line rides here (cost block: provider, model, tokens; payload: tier, escalation reason, budget, pack entry ids). */
  draftGenerated: "light.draft_generated",
  /** Generation failed VISIBLY — provider error or over-budget assembly; the reason is the payload. Never a silent stub fallback. */
  draftGenerationFailed: "light.draft_generation_failed",
  /** A compliance check was recorded against the no-go register (0026). */
  complianceChecked: "communication.compliance_checked",
  /** A stamped-authority holder edited a draft before stamping — before/after in the payload; pre-flight re-runs. */
  draftEdited: "communication.draft_edited",
  /** A refine signal (edit or rejection reason) landed in draft_feedback (PR-4). */
  draftFeedbackRecorded: "draft.feedback_recorded",
} as const satisfies Record<string, EventAction>;

/**
 * Session 16 — inbound capture and the supersede engine. Same JUDGMENT as
 * above: kinds are TS constants, the single truth every emitter imports.
 */
export const INBOUND_EVENT_KINDS = {
  /** A client message arrived (WhatsApp webhook or Graph poll) and became a
   * communications row — provider ids and window state in the payload. */
  communicationReceived: "communication.received",
  /** A pending draft was superseded (terminal) — reason and the replacing
   * communication id in the payload. new_inbound | human_replied. */
  communicationSuperseded: "communication.superseded",
  /** PR-F (133e): at the stamp, the approver-mode sign-off resolved to the
   * stamping approver's display name — the resolved name in the payload;
   * WYSIWYS: the body the approver saw is the body that dispatches. */
  communicationSignOffResolved: "communication.sign_off_resolved",
  /** PR-D: a per-conversation auto-draft pause was toggled, or the settle
   * override changed — the thread and the new value in the payload. */
  threadDraftingPreferenceChanged: "thread.drafting_preference_changed",
} as const satisfies Record<string, EventAction>;

/**
 * Session 21 — the stuck-definition escape hatch. Same JUDGMENT as above:
 * kinds are TS constants, the single truth every emitter imports. The run and
 * step kinds predate this constant block and remain literals in workflow.ts;
 * new workflow kinds land here.
 */
export const WORKFLOW_EVENT_KINDS = {
  /** An owner withdrew a pending_approval definition — terminal, reason in
   * the payload with the definition's key and version; the row carries the
   * same facts (0034). */
  definitionWithdrawn: "workflow.definition_withdrawn",
} as const satisfies Record<string, EventAction>;

/**
 * Session 22 — the Meta Conversions loop (WS1). Same JUDGMENT as above:
 * kinds are TS constants, the single truth every emitter imports. The
 * Session 6 STUB kind (meta.signal_stubbed) is retired from the executor;
 * its historical rows stand on the append-only ledger.
 */
export const CONVERSION_EVENT_KINDS = {
  /** An outcome event left for Meta's Conversions API — the payload AS SENT
   * (hashed em/ph only, never raw PII) rides the event payload (ruling 1b). */
  conversionSent: "meta.conversion_sent",
  /** Meta refused (or the send failed) — reason, attempt count and
   * retryability recorded; the stage transition was never blocked (1e). */
  conversionSendFailed: "meta.conversion_send_failed",
  /** The daily ad-spend pull ran — campaigns and rows in the payload (1c). */
  spendPulled: "meta.spend_pulled",
  /** The daily pull stood down visibly — e.g. the token lacks ads_read; the
   * missing scope is named (1c, fail closed). */
  spendPullSkipped: "meta.spend_pull_skipped",
} as const satisfies Record<string, EventAction>;

export type OnboardingEventKind = (typeof EVENT_KINDS)[keyof typeof EVENT_KINDS];
