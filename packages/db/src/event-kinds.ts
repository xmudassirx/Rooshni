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
  /** Defect-trio hotfix (2 Aug 2026): a stamp-holder collapsed a quiet-hours
   * hold — SEND NOW. The human actor rides the event; messaging a client at
   * 22:00 is a recorded human decision, never a silent one. */
  communicationQuietHoursOverridden: "communication.quiet_hours_overridden",
  /** Defect-pair hotfix (2 Aug 2026): a stamp-holder retried a FAILED send —
   * same body, same stamp, transport re-attempts (0040). The human actor and
   * the failure being answered ride the payload. */
  communicationSendRetried: "communication.send_retried",
  /** Session 33 (D184c): the stamp landed inside quiet hours and the
   * stamp-holder chose APPROVE AND SCHEDULE — scheduled_for carries the
   * chosen instant and dispatch honours it (the D163 machinery). The human
   * actor rides the event; the choice is recorded, never silent. */
  communicationScheduled: "communication.scheduled",
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
  /** Session 25: a register-screen breach (em/en dash) triggered the automatic
   * retry-once — the violation fed back into the regeneration prompt. One
   * retry, never a loop; a second failure lands draftGenerationFailed. */
  draftRegisterRetried: "light.draft_register_retried",
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
  /** HOTFIX (2 Aug 2026, founder-ruled): a claimed inbound mail row sat
   * unprocessed past the stale window — an evented, VISIBLE failure (the
   * silence was the worst part of the defect). Emitted once per claim; the
   * recovery sweep keeps retrying and the payload carries the last error. */
  mailClaimStale: "inbound.mail_claim_stale",
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

/**
 * Session 22 — billing & usage (WS2). Same JUDGMENT as above: kinds are TS
 * constants, the single truth every emitter imports.
 */
export const BILLING_EVENT_KINDS = {
  /** The month's metered spend crossed the owner-set soft cap — once per
   * month on The Record; the pages banner from live truth (ruling 2b). */
  softCapCrossed: "billing.soft_cap_crossed",
} as const satisfies Record<string, EventAction>;

/**
 * Session 27 — the returning-leads engine (D158). Same JUDGMENT as above:
 * kinds are TS constants, the single truth every emitter imports.
 */
export const RETURNING_EVENT_KINDS = {
  /** A known contact submitted a form again while their enquiry is OPEN —
   * the resubmission lands on that enquiry's timeline (D158d, open fork).
   * Payload: leadgen id, form id/label, the answers, the changed fields. */
  resubmissionReceived: "engagement.resubmission_received",
  /** A known contact returned after their enquiry closed — a NEW enquiry
   * was opened; this kind lands on the PREDECESSOR with the successor's id
   * (D158d, closed fork — the link visible on the old timeline). */
  successorOpened: "engagement.successor_opened",
  /** The same moment on the SUCCESSOR: opened as a returning lead, its
   * predecessor's id in the payload (the link visible on the new timeline). */
  openedFromPredecessor: "engagement.opened_from_predecessor",
  /** The system marker posted into the contact's existing thread (D158a) —
   * a fact, not Light's act and not a human's; neutral chrome everywhere. */
  returningMarkerPosted: "communication.returning_marker_posted",
  /** Session 28 (D174b): a returning submission presented a NEW value on
   * the other channel — added to the matched contact as an additional
   * channel, consent carried from the form; provenance (leadgen id, form
   * id, consent source) in the payload. */
  channelAdded: "contact.channel_added",
} as const satisfies Record<string, EventAction>;

/** Session 27 (D158a): the marker's kind marker on the communications row
 * (attributes.kind). Declared here — imported by both the ingest side and
 * the settle sweep without a module cycle. Not an event kind. */
export const RETURNING_MARKER_KIND = "returning_lead_marker";

/**
 * Session 27 — route classification, complete shape (D161). Same JUDGMENT
 * as above. One kind for every source: the payload's `source` field is the
 * provenance (human | form_answer | light | form_default) and the surfaces
 * chip from it — gold for Light, neutral otherwise.
 */
export const ROUTE_EVENT_KINDS = {
  /** The enquiry's visa route was set or reclassified through the 0042
   * door. Payload: route, source, reason (Light's stated reason, or the
   * human's optional one), previous_route, previous_source. */
  routeSet: "engagement.route_set",
  /** Session 31 (D179c): Light's pre-compose route read ran — confident or
   * abstained, the read is on The Record with its reason and priced spend
   * (the D161d visibility: "ran and abstained" is a recorded fact, never a
   * silence). Payload: key (null on abstention), reason, applied. */
  routeRead: "engagement.route_read",
} as const satisfies Record<string, EventAction>;

/**
 * Session 30 (177c) — the contact archive. Same JUDGMENT as above: kinds
 * are TS constants, the single truth every emitter imports.
 */
export const CONTACT_EVENT_KINDS = {
  /** An owner archived a contact — it leaves resolution and its channels
   * leave consent while its history stands untouched; deletion does not
   * exist. Payload: display_name, channels_archived, the optional reason. */
  archived: "contact.archived",
} as const satisfies Record<string, EventAction>;

/**
 * Session 32 — Light's Memory (D181). Same JUDGMENT as above: kinds are TS
 * constants, the single truth every emitter imports. The Session 9 reserved
 * kind memory.proposals_raised belonged to the dead Spec 2 card model and is
 * not emitted by this vocabulary.
 */
export const MEMORY_EVENT_KINDS = {
  /** A memory entry was born (fact | instruction | observation) — kind,
   * title and fact_key (facts) in the payload. */
  entryCreated: "memory.entry_created",
  /** An entry was edited: the append-only supersede — a successor row was
   * inserted and the predecessor deactivated, chained. One act, one event;
   * predecessor and successor ids in the payload. */
  entrySuperseded: "memory.entry_superseded",
  /** An entry was deactivated without a successor — it stops riding drafts;
   * its history stands. Optional reason in the payload. */
  entryDeactivated: "memory.entry_deactivated",
  /** A human promoted an observation to a standing instruction — one click,
   * theirs (the database refuses any non-human author). The observation is
   * superseded by the instruction; both ids in the payload. */
  observationPromoted: "memory.observation_promoted",
  /** The ripple sweep ran on a fact edit — ONE act: "N corrections
   * proposed, M manual tasks raised", with every correction and task id,
   * the old and new values, and any deferred (website) surfaces named. */
  factRippleSwept: "memory.fact_ripple_swept",
  /** A human stamped a sweep correction — the change APPLIED: a template
   * re-issued (D102 lane, new version) or a knowledge entry updated (new
   * version through the existing door). Correction id, surface and the new
   * version in the payload. Nothing ever applies without this stamp. */
  correctionApplied: "memory.correction_applied",
  /** A human declined a sweep correction — reason recorded; the surface
   * stands untouched. */
  correctionRejected: "memory.correction_rejected",
} as const satisfies Record<string, EventAction>;

/**
 * Session 34 — the MCP read door (D188). Same JUDGMENT as above: kinds are
 * TS constants, the single truth every emitter imports.
 */
export const MCP_EVENT_KINDS = {
  /** A founder minted the MCP credential in Settings → Integrations — the
   * machine actor and the granted tool set in the payload; the credential
   * itself is hashed at rest and never rides any event (D188c). */
  credentialMinted: "mcp.credential_minted",
  /** A founder revoked the credential — the door closes for every token
   * bound to it, immediately. */
  credentialRevoked: "mcp.credential_revoked",
  /** An external AI client called an MCP tool as "Claude via MCP" — tool
   * name and scope in the payload, SUMMARISED, never the response body
   * (D188a: every call lands on The Record as that actor). */
  toolCalled: "mcp.tool_called",
} as const satisfies Record<string, EventAction>;

export type OnboardingEventKind = (typeof EVENT_KINDS)[keyof typeof EVENT_KINDS];
