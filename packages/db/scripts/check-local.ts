import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { scaleDurationMs } from "@rooshni/config";
import { verifyStripeSignature } from "../src/stripe";
import { verifyMetaSignature } from "../src/meta";
import {
  describeSendWindow,
  isQuietHoursSet,
  quietHoursFromSendWindow,
  quietHoursHoldUntil,
  resolveQuietHours,
  resolveQuietHoursWithSource,
  sendWindowFromQuietHours,
  QUIET_HOURS_DEFAULT,
} from "../src/quiet-hours";
import { classifyCommChange, rejoinDelayMs, shouldRejoin } from "../../../apps/web/lib/live-inbox-rules";
import { foldLeadContext } from "../../../apps/web/lib/lead-context";
import { recordRowTarget } from "../../../apps/web/lib/record-row";
import { buildTimeline } from "../../../apps/web/lib/enquiry-timeline";
import { archivedContactRedirect } from "../../../apps/web/lib/archive-redirect";
import {
  carriesRuledLadder,
  chooseReissueAction,
  reissueNudgeLadderSteps,
  ruledLadderDescription,
  type LadderStep,
} from "../src/nudge-ladder";
import { declaredTemplateQuietHours } from "../src/quiet-hours";
import { evaluateAutoClose } from "../src/auto-close";
import { dueNurtureStep, type NurtureStamps } from "../src/onboarding";
import { evaluateBasicsReadiness, resolveBasicsRequiredKeys, CANONICAL_BASICS_KEYS } from "../src/first-light";
import { canWithdrawWorkflowDefinition, resolveTemplateBody } from "../src/workflow";
import { formAnswersFromFieldData } from "../src/meta";
import {
  classifyRoute,
  composeDraft,
  composeWithRegisterRetry,
  FEE_PROHIBITION_LINE,
  findFeeBreach,
  findRegisterBreach,
  isTransientProviderError,
  leadTextFromAnswers,
  matchRoutes,
  memoryFactLines,
  memoryInstructionLines,
  selectKnowledgeEntries,
  PermanentGenerationError,
  RegisterBreachError,
  REGISTER_PUNCTUATION_LINE,
  type ClassifyFn,
  type GenerateFn,
  type KnowledgeEntry,
} from "../src/drafting";
import {
  defaultSurfacesForFactKey,
  healedCarriedSurfaces,
  memoryFactValue,
  memoryInstructionTokens,
  planFactSweep,
  resolveBookingUrlWithMemory,
  resolveSignOffWithMemory,
  GOOGLE_BUSINESS_PROFILE_SURFACE,
  MEMORY_INSTRUCTION_TOKEN_CEILING,
  type MemoryContext,
  type SweepCarrier,
} from "../src/memory";
import { resolveEscalation, LIGHT_MODEL_FLOOR, LIGHT_MODEL_ESCALATION, DRAFT_CONTEXT_BUDGETS } from "../src/model-router";
import {
  assembleReplyPrompt,
  composeReplyDraft,
  type ComposeReplyInput,
} from "../src/drafting";
import {
  nextSettleDueAt,
  resolveSettleMinutes,
  resolveSettleRealMs,
  SETTLE_WINDOW_DEFAULT_MINUTES,
} from "../src/supersede";
import { parseReferenceIds } from "../src/mailbox";
import { resolveSignOffBody, resolveSignOffMode, resolveSignOffText } from "../src/sign-off";
import { resolveBookingUrl, substituteBookingLink } from "../src/booking-link";
import {
  extractEmailPlainText,
  plainTextOfBody,
  renderEmailHtml,
  resolveEmailIdentity,
} from "../src/email-html";
import { whatsAppInboundConsent, mailClaimStaleCutoffIso, MAIL_CLAIM_STALE_AFTER_MS } from "../src/inbound";
import { whatsAppConnectionState } from "../src/whatsapp";
import { canArchiveContact } from "../src/contacts";
import { buildGmailMime, extractGmailBodyText } from "../src/gmail";
import { honourQuietHoursOverride, resolveMailProvider, selectEmailCarrier, type OutboundProviders, type SendResult } from "../src/send";
import { rankGuideCandidates, storageSlug, ATTACHMENT_MAX_BYTES } from "../src/route-guides";
import {
  buildConversionPayload,
  buildConversionUserData,
  classifyMetaSpendError,
  MAX_CONVERSION_ATTEMPTS,
  resolveConversionsConfig,
  resolveRuledMoves,
  selectConversionCandidates,
  sha256Hex,
} from "../src/conversions";
import {
  evaluateAiBudget,
  formatMeteredGbp,
  guardGenerationBudget,
  pricedAmountGbp,
  resolveAiBudget,
  softCapJustCrossed,
} from "../src/ai-budget";
import { priceGeneration, USD_TO_GBP_RATE } from "../src/model-router";
import { computeLightPerformance, weekWindowUtc } from "../src/light-performance";
import {
  clampPage,
  clampPageSize,
  DEFAULT_PAGE_SIZE,
  MAX_LIST_WINDOW,
  pageRange,
} from "../src/read-policy";
import {
  buildMarkerBody,
  diffFormAnswers,
  planChannelEnrichment,
  resolveFormRouteDefault,
  resolveKnownContactId,
  routeFromFormAnswers,
} from "../src/returning-leads";
import { lightMaySetRoute, routeSourceRank } from "../src/routes";
import { normaliseRouteClassification } from "../src/drafting";
import { parseReturningMarker } from "../../../apps/web/lib/returning-marker";

// Timers are proven at compressed time (PLAYBOOK §4.4) — the harness pins the
// dev scale so wait-step scheduling is deterministic here regardless of the
// caller's environment.
process.env.TIME_SCALE = "1440";

/**
 * Local migration validation — no live database required.
 *
 * Boots an in-memory Postgres (PGlite), fakes the Supabase surroundings the
 * migrations assume (auth schema, auth.uid(), anon/authenticated/service_role
 * roles), applies every migration in order, then smoke-tests the structural
 * rules: append-only ledger, human-stamp enforcement, RLS tenancy walls.
 */

const db = new PGlite();

let passed = 0;
let failed = 0;

async function expectOk(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${label}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : err}`);
  }
}

async function expectError(label: string, pattern: RegExp, fn: () => Promise<unknown>) {
  try {
    await fn();
    failed += 1;
    console.error(`  FAIL  ${label}: expected an error, none was raised`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (pattern.test(message)) {
      passed += 1;
      console.log(`  PASS  ${label}`);
    } else {
      failed += 1;
      console.error(`  FAIL  ${label}: wrong error: ${message}`);
    }
  }
}

async function main() {
  // --- Supabase stand-ins -------------------------------------------------
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;

    create schema auth;
    create table auth.users (
      id uuid primary key,
      email text unique
    );
    -- Stand-in for Supabase's auth.uid(): reads the request claim if set.
    create function auth.uid() returns uuid
    language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

    -- Stand-in for Supabase's auth.jwt(): the full claims object.
    create function auth.jwt() returns jsonb
    language sql stable
    as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;

    -- Supabase grants table privileges to its API roles by default; RLS is
    -- the actual wall. Mirror that so policy tests are realistic.
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public
      grant all on tables to anon, authenticated, service_role;
  `);

  // --- Apply migrations ---------------------------------------------------
  const migrationsDir = resolve(import.meta.dirname, "../migrations");
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

  console.log("Applying migrations:");
  for (const file of files) {
    try {
      await db.exec(readFileSync(resolve(migrationsDir, file), "utf8"));
      console.log(`  ok    ${file}`);
    } catch (err) {
      console.error(`  FAIL  ${file}: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }

  // --- Fixture rows -------------------------------------------------------
  const ids = {
    user: "00000000-0000-4000-8000-000000000001",
    stranger: "00000000-0000-4000-8000-000000000002",
    member: "00000000-0000-4000-8000-000000000003",
  };

  const fixture = await db.query<{
    account_id: string;
    business_id: string;
    human_id: string;
    agent_id: string;
    template_id: string;
    type_id: string;
    stage_id: string;
  }>(
    `
    with u as (
      insert into auth.users (id, email) values ($1, 'owner@example.test') returning id
    ), acc as (
      insert into public.accounts (name, owner_user_id)
      select 'Test Account', id from u returning id
    ), biz as (
      insert into public.businesses (account_id, name)
      select id, 'Test Business' from acc returning id, account_id
    ), mem as (
      insert into public.memberships (user_id, business_id, role)
      select $1, id, 'owner' from biz returning id
    ), human as (
      insert into public.actors (account_id, actor_type, display_name, user_id)
      select account_id, 'human', 'Test Human', $1 from biz returning id
    ), agent as (
      insert into public.actors (account_id, actor_type, display_name)
      select account_id, 'agent', 'Test Agent' from biz returning id
    ), tpl as (
      insert into public.templates (business_id, vertical)
      select id, 'test_vertical' from biz returning id
    ), etype as (
      insert into public.engagement_types (template_id, key, label)
      select id, 'enquiry', 'Enquiry' from tpl returning id
    ), stage as (
      insert into public.stage_definitions (engagement_type_id, key, label, sort_order)
      select id, 'new_lead', 'New lead', 1 from etype returning id
    )
    select
      (select id from acc) as account_id,
      (select id from biz) as business_id,
      (select id from human) as human_id,
      (select id from agent) as agent_id,
      (select id from tpl) as template_id,
      (select id from etype) as type_id,
      (select id from stage) as stage_id
  `,
    [ids.user]
  );
  const f = fixture.rows[0]!;

  // Session 15 (0026): agent-drafted rows created after the migration earn
  // the stamp only with a recorded compliance check — heuristics + a
  // generation-time attestation, on exactly the stamped wording. Tests that
  // lawfully approve agent drafts record the check first, precisely as the
  // drafting engine does at generation.
  const TEST_ATTESTATION = JSON.stringify({
    attested: true,
    mode: "approved_template",
    statement: "harness fixture attestation",
  });
  const recordCompliance = async (commId: string, actorId: string = f.agent_id) => {
    await db.query(`select public.run_compliance_check($1, $2, $3::jsonb)`, [commId, actorId, TEST_ATTESTATION]);
  };

  // Session 2 fixtures: a non-owner human (member) and a second agent that
  // holds no grants at all — the refusal cases of Spec 3.
  const fixture2 = await db.query<{ human2_id: string; agent2_id: string }>(
    `
    with u2 as (
      insert into auth.users (id, email) values ($1, 'member@example.test') returning id
    ), mem2 as (
      insert into public.memberships (user_id, business_id, role)
      values ($1, $2, 'member') returning id
    ), human2 as (
      insert into public.actors (account_id, actor_type, display_name, user_id)
      values ($3, 'human', 'Test Member', $1) returning id
    ), agent2 as (
      insert into public.actors (account_id, actor_type, display_name)
      values ($3, 'agent', 'Ungranted Agent') returning id
    )
    select
      (select id from human2) as human2_id,
      (select id from agent2) as agent2_id
    `,
    [ids.member, f.business_id, f.account_id]
  );
  const h2 = fixture2.rows[0]!;

  // Spec 3 fixture grants: the test agent is Light-shaped — enquiries execute
  // (Level 2 work) plus comms.email execute (draft + submit, never approve),
  // business scope, standing, granted by the owner via chat.
  const grantSql = `insert into public.grants
    (business_id, created_by, grantee_actor_id, tool, access, scope, duration, expires_at, granted_by_actor_id, via)
    values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10) returning id`;
  const bizScope = JSON.stringify({ level: "business", ref: f.business_id });

  await db.query(grantSql, [f.business_id, f.human_id, f.agent_id, "enquiries", "execute", bizScope, "standing", null, f.human_id, "chat"]);
  await db.query(grantSql, [f.business_id, f.human_id, f.agent_id, "comms.email", "execute", bizScope, "standing", null, f.human_id, "chat"]);

  console.log("\nStructural rules:");

  // UUIDv7 ids are time-ordered
  await expectOk("ids default to UUIDv7 (version nibble = 7)", async () => {
    const r = await db.query<{ v: string }>(
      `select substring(id::text from 15 for 1) as v from public.accounts limit 1`
    );
    if (r.rows[0]!.v !== "7") throw new Error(`got version ${r.rows[0]!.v}`);
  });

  // Events ledger: append-only
  const event = await db.query<{ id: string }>(
    `insert into public.events (business_id, actor_id, action, entity_type, payload)
     values ($1, $2, 'contact.created', 'contact', '{}') returning id`,
    [f.business_id, f.human_id]
  );
  await expectError("events UPDATE is refused", /append-only/, () =>
    db.query(`update public.events set action = 'contact.updated' where id = $1`, [
      event.rows[0]!.id,
    ])
  );
  await expectError("events DELETE is refused", /append-only/, () =>
    db.query(`delete from public.events where id = $1`, [event.rows[0]!.id])
  );
  await expectError("events action must be namespaced", /events_action_is_namespaced/, () =>
    db.query(
      `insert into public.events (business_id, actor_id, action) values ($1, $2, 'not-namespaced')`,
      [f.business_id, f.human_id]
    )
  );

  // Engagements: owner must be human
  await expectError("engagement owner cannot be an agent", /human actor/, () =>
    db.query(
      `insert into public.engagements (business_id, created_by, template_type_id, title, stage_id, owner_actor_id)
       values ($1, $2, $3, 'Test enquiry', $4, $5)`,
      [f.business_id, f.agent_id, f.type_id, f.stage_id, f.agent_id]
    )
  );
  const engagement = await db.query<{ id: string }>(
    `insert into public.engagements (business_id, created_by, template_type_id, title, stage_id, owner_actor_id)
     values ($1, $2, $3, 'Test enquiry', $4, $5) returning id`,
    [f.business_id, f.agent_id, f.type_id, f.stage_id, f.human_id]
  );

  // Stage history: append-only
  await db.query(
    `insert into public.stage_history (business_id, engagement_id, to_stage, moved_by)
     values ($1, $2, $3, $4)`,
    [f.business_id, engagement.rows[0]!.id, f.stage_id, f.human_id]
  );
  await expectError("stage_history UPDATE is refused", /append-only/, () =>
    db.query(`update public.stage_history set moved_at = now()`)
  );

  // Communications: the stamp must be human
  const contact = await db.query<{ id: string }>(
    `insert into public.contacts (business_id, created_by, type, display_name)
     values ($1, $2, 'person', 'Test Person') returning id`,
    [f.business_id, f.agent_id]
  );
  // Consent lives per channel (Spec 1 §4.1) and readiness pre-flight demands
  // it before any outbound message may reach approved/sent (Spec 3 §6).
  await db.query(
    `insert into public.contact_channels (business_id, created_by, contact_id, channel, value, is_primary, consent)
     values ($1, $2, $3, 'email', 'test.person@example.test', true, '{"transactional": true, "marketing": true}'::jsonb)`,
    [f.business_id, f.agent_id, contact.rows[0]!.id]
  );
  const thread = await db.query<{ id: string }>(
    `insert into public.comm_threads (business_id, created_by, contact_id, channel)
     values ($1, $2, $3, 'email') returning id`,
    [f.business_id, f.agent_id, contact.rows[0]!.id]
  );
  await expectError(
    "outbound comm cannot be 'sent' without an approver",
    /approved_by_actor_id|Level 3/,
    () =>
      db.query(
        `insert into public.communications (business_id, created_by, thread_id, channel, direction, status, body)
         values ($1, $2, $3, 'email', 'outbound', 'sent', 'hello')`,
        [f.business_id, f.agent_id, thread.rows[0]!.id]
      )
  );
  // Two structural layers refuse this: the grants engine (agents cannot hold
  // approvals.*, so the stamp check fails first) and the Session 1 human-actor
  // trigger behind it. Either refusal proves the rule.
  await expectError(
    "outbound comm cannot be approved BY AN AGENT (the AI cannot hold the stamp)",
    /HUMAN actor|approvals\.comms/,
    () =>
      db.query(
        `insert into public.communications (business_id, created_by, thread_id, channel, direction, status, body, approved_by_actor_id)
         values ($1, $2, $3, 'email', 'outbound', 'approved', 'hello', $4)`,
        [f.business_id, f.agent_id, thread.rows[0]!.id, f.agent_id]
      )
  );
  await expectOk("outbound comm sends with a human approver", async () => {
    // Session 15: born as a draft, compliance-checked, then sent — the
    // agent-drafted insert-at-sent shortcut now correctly demands a check.
    const r = await db.query<{ id: string }>(
      `insert into public.communications (business_id, created_by, thread_id, channel, direction, status, body)
       values ($1, $2, $3, 'email', 'outbound', 'draft', 'hello') returning id`,
      [f.business_id, f.agent_id, thread.rows[0]!.id]
    );
    await recordCompliance(r.rows[0]!.id);
    await db.query(
      `update public.communications set status = 'sent', approved_by_actor_id = $2 where id = $1`,
      [r.rows[0]!.id, f.human_id]
    );
  });

  // Content: publishing needs a human
  await expectError("content cannot be published by an agent", /HUMAN actor/, () =>
    db.query(
      `insert into public.content_items (business_id, created_by, content_type, title, slug, state, published_by_actor_id)
       values ($1, $2, 'page', 'Test', 'test', 'published', $3)`,
      [f.business_id, f.agent_id, f.agent_id]
    )
  );

  // ---------------------------------------------------------------------
  // Spec 3 — the grants engine: levels as data, meta-rules on grants.
  // ---------------------------------------------------------------------
  console.log("\nSpec 3 — grants engine:");

  await expectOk("permission levels 0–4 exist as data", async () => {
    const r = await db.query<{ n: number; mx: number }>(
      `select count(*)::int as n, max(level)::int as mx from public.permission_levels`
    );
    if (r.rows[0]!.n !== 5 || r.rows[0]!.mx !== 4) {
      throw new Error(`saw ${r.rows[0]!.n} levels, max ${r.rows[0]!.mx}`);
    }
  });

  await expectError("a non-human granter is refused", /HUMAN actor/, () =>
    db.query(grantSql, [f.business_id, f.human_id, h2.agent2_id, "calendar", "view", bizScope, "standing", null, f.agent_id, "chat"])
  );

  await expectError("self-granting is refused (Level 4)", /grants_no_self_granting/, () =>
    db.query(grantSql, [f.business_id, f.human_id, f.human_id, "calendar", "view", bizScope, "standing", null, f.human_id, "chat"])
  );

  await expectError(
    "an agent cannot hold approvals.* (the AI cannot hold the stamp)",
    /unholdable/,
    () =>
      db.query(grantSql, [f.business_id, f.human_id, f.agent_id, "approvals.comms", "execute", bizScope, "standing", null, f.human_id, "chat"])
  );

  await expectError("a human without settings.team cannot grant", /settings\.team/, () =>
    db.query(grantSql, [f.business_id, h2.human2_id, h2.agent2_id, "calendar", "view", bizScope, "standing", null, h2.human2_id, "chat"])
  );

  await expectOk("owner grants settings.team to a member; the member can then grant", async () => {
    await db.query(grantSql, [f.business_id, f.human_id, h2.human2_id, "settings.team", "execute", bizScope, "standing", null, f.human_id, "dashboard"]);
    await db.query(grantSql, [f.business_id, h2.human2_id, h2.agent2_id, "calendar", "view", bizScope, "standing", null, h2.human2_id, "chat"]);
  });

  await expectError("a business-scoped grant must reference its own business", /its own business/, () =>
    db.query(grantSql, [f.business_id, f.human_id, f.agent_id, "calendar", "view", JSON.stringify({ level: "business", ref: ids.user }), "standing", null, f.human_id, "chat"])
  );

  await expectError("a scope without a ref is refused (no null scopes, ever)", /grants_scope_shape/, () =>
    db.query(grantSql, [f.business_id, f.human_id, f.agent_id, "calendar", "view", JSON.stringify({ level: "business" }), "standing", null, f.human_id, "chat"])
  );

  await expectError("standing grants cannot carry an expiry", /grants_duration_expiry/, () =>
    db.query(grantSql, [f.business_id, f.human_id, f.agent_id, "calendar", "view", bizScope, "standing", new Date().toISOString(), f.human_id, "chat"])
  );

  await expectError("a tool outside the registry cannot be granted", /grants_tool_fkey|foreign key/, () =>
    db.query(grantSql, [f.business_id, f.human_id, f.agent_id, "made.up", "view", bizScope, "standing", null, f.human_id, "chat"])
  );

  await expectOk("level resolution: tenant overrides raise, never lower", async () => {
    await db.query(
      `update public.businesses set settings = '{"tool_level_overrides":{"comms.email":1,"calendar":3}}'::jsonb where id = $1`,
      [f.business_id]
    );
    const r = await db.query<{ email: number; cal: number }>(
      `select
         private.resolve_tool_level($1, 'comms.email')::int as email,
         private.resolve_tool_level($1, 'calendar')::int as cal`,
      [f.business_id]
    );
    if (r.rows[0]!.email !== 3) throw new Error(`comms.email floor lowered to ${r.rows[0]!.email}`);
    if (r.rows[0]!.cal !== 3) throw new Error(`calendar raise ignored: ${r.rows[0]!.cal}`);
  });

  await expectError("grant terms are immutable after issue", /immutable/, () =>
    db.query(
      `update public.grants set access = 'execute' where grantee_actor_id = $1 and tool = 'calendar' and revoked_at is null`,
      [h2.agent2_id]
    )
  );

  await expectOk("the owner revokes the agent's calendar grant (one-tap, kept for audit)", () =>
    db.query(
      `update public.grants set revoked_at = now(), revoked_by_actor_id = $1
       where grantee_actor_id = $2 and tool = 'calendar'`,
      [f.human_id, h2.agent2_id]
    )
  );

  await expectError("a revoked grant cannot be altered", /permanent/, () =>
    db.query(
      `update public.grants set revoked_at = null where grantee_actor_id = $1 and tool = 'calendar'`,
      [h2.agent2_id]
    )
  );

  // ---------------------------------------------------------------------
  // Spec 3 — enforcement wiring: the grant checks on every existing path.
  // ---------------------------------------------------------------------
  console.log("\nSpec 3 — enforcement wiring:");

  await expectError(
    "an ungranted actor is refused at Level 2 (create a task)",
    /enquiries \(execute\)/,
    () =>
      db.query(
        `insert into public.tasks (business_id, created_by, title, assignee_actor_id)
         values ($1, $2, 'Rogue task', $2)`,
        [f.business_id, h2.agent2_id]
      )
  );

  await expectOk("a granted agent performs Level 2 (create a task)", () =>
    db.query(
      `insert into public.tasks (business_id, created_by, engagement_id, title, assignee_actor_id)
       values ($1, $2, $3, 'Chase documents', $4)`,
      [f.business_id, f.agent_id, engagement.rows[0]!.id, f.human_id]
    )
  );

  await expectOk("authorised use stamps the grant (use_count)", async () => {
    const r = await db.query<{ n: number }>(
      `select use_count::int as n from public.grants
       where grantee_actor_id = $1 and tool = 'enquiries'`,
      [f.agent_id]
    );
    if (r.rows[0]!.n < 1) throw new Error(`use_count is ${r.rows[0]!.n}`);
  });

  let lightDraftId = "";
  await expectOk("a granted agent drafts an outbound email (the Light path)", async () => {
    const r = await db.query<{ id: string }>(
      `insert into public.communications (business_id, created_by, thread_id, channel, direction, status, body, drafted_by_actor_id)
       values ($1, $2, $3, 'email', 'outbound', 'draft', 'Draft for approval', $2) returning id`,
      [f.business_id, f.agent_id, thread.rows[0]!.id]
    );
    lightDraftId = r.rows[0]!.id;
  });

  // The founder demo: the agent stamps its own draft — and the database
  // refuses. The exact error text is printed so the refusal is visible.
  try {
    await db.query(
      `update public.communications set status = 'approved', approved_by_actor_id = $2 where id = $1`,
      [lightDraftId, f.agent_id]
    );
    failed += 1;
    console.error("  FAIL  an agent approves its own draft: no error was raised");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/approvals\.comms|HUMAN actor/.test(message)) {
      passed += 1;
      console.log("  PASS  an agent cannot stamp its own draft — the database says:");
      console.log(`        "${message}"`);
    } else {
      failed += 1;
      console.error(`  FAIL  an agent approves its own draft: wrong error: ${message}`);
    }
  }

  await expectError("an ungranted actor cannot even draft outbound email", /comms\.email/, () =>
    db.query(
      `insert into public.communications (business_id, created_by, thread_id, channel, direction, status, body)
       values ($1, $2, $3, 'email', 'outbound', 'draft', 'nope')`,
      [f.business_id, h2.agent2_id, thread.rows[0]!.id]
    )
  );

  let smsDraftId = "";
  await expectOk("draft access drafts, at draft status only", async () => {
    await db.query(grantSql, [f.business_id, f.human_id, h2.agent2_id, "comms.sms", "draft", bizScope, "standing", null, f.human_id, "chat"]);
    const r = await db.query<{ id: string }>(
      `insert into public.communications (business_id, created_by, thread_id, channel, direction, status, body)
       values ($1, $2, $3, 'sms', 'outbound', 'draft', 'sms draft') returning id`,
      [f.business_id, h2.agent2_id, thread.rows[0]!.id]
    );
    smsDraftId = r.rows[0]!.id;
  });

  await expectError(
    "draft access cannot submit into the approval queue",
    /comms\.sms \(execute\)/,
    () => db.query(`update public.communications set status = 'pending_approval' where id = $1`, [smsDraftId])
  );

  await expectError("an expired grant is dead at use time", /comms\.whatsapp/, async () => {
    await db.query(grantSql, [
      f.business_id, f.human_id, h2.agent2_id, "comms.whatsapp", "execute", bizScope,
      "until", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), f.human_id, "chat",
    ]);
    await db.query(
      `insert into public.communications (business_id, created_by, thread_id, channel, direction, status, body)
       values ($1, $2, $3, 'whatsapp', 'outbound', 'draft', 'too late')`,
      [f.business_id, h2.agent2_id, thread.rows[0]!.id]
    );
  });

  await expectError(
    "a human approver without approvals.comms is refused (approving is itself a tool)",
    /approvals\.comms/,
    () =>
      db.query(
        `insert into public.communications (business_id, created_by, thread_id, channel, direction, status, body, approved_by_actor_id)
         values ($1, $2, $3, 'email', 'outbound', 'approved', 'hello', $4)`,
        [f.business_id, f.agent_id, thread.rows[0]!.id, h2.human2_id]
      )
  );

  await expectOk("with approvals.comms granted, the same human's stamp lands", async () => {
    await db.query(grantSql, [f.business_id, f.human_id, h2.human2_id, "approvals.comms", "execute", bizScope, "standing", null, f.human_id, "dashboard"]);
    const r = await db.query<{ id: string }>(
      `insert into public.communications (business_id, created_by, thread_id, channel, direction, status, body)
       values ($1, $2, $3, 'email', 'outbound', 'draft', 'hello again') returning id`,
      [f.business_id, f.agent_id, thread.rows[0]!.id]
    );
    await recordCompliance(r.rows[0]!.id);
    await db.query(
      `update public.communications set status = 'approved', approved_by_actor_id = $2 where id = $1`,
      [r.rows[0]!.id, h2.human2_id]
    );
  });

  await expectError("a channel with no registered tool cannot carry outbound", /No tool/, () =>
    db.query(
      `insert into public.communications (business_id, created_by, thread_id, channel, direction, status, body)
       values ($1, $2, $3, 'internal_note', 'outbound', 'draft', 'odd')`,
      [f.business_id, f.agent_id, thread.rows[0]!.id]
    )
  );

  await expectError(
    "a non-owner human cannot publish without approvals.content",
    /approvals\.content/,
    () =>
      db.query(
        `insert into public.content_items (business_id, created_by, content_type, title, slug, state, published_by_actor_id)
         values ($1, $2, 'page', 'Gated page', 'gated-page', 'published', $3)`,
        [f.business_id, f.human_id, h2.human2_id]
      )
  );

  await expectOk("the owner publishes (implicit full grant set)", () =>
    db.query(
      `insert into public.content_items (business_id, created_by, content_type, title, slug, state, published_by_actor_id)
       values ($1, $2, 'page', 'Owner page', 'owner-page', 'published', $2)`,
      [f.business_id, f.human_id]
    )
  );

  await expectOk("revoking comms.email shuts the door immediately", () =>
    db.query(
      `update public.grants set revoked_at = now(), revoked_by_actor_id = $1
       where grantee_actor_id = $2 and tool = 'comms.email'`,
      [f.human_id, f.agent_id]
    )
  );

  await expectError("the revoked agent can no longer draft email", /comms\.email/, () =>
    db.query(
      `insert into public.communications (business_id, created_by, thread_id, channel, direction, status, body)
       values ($1, $2, $3, 'email', 'outbound', 'draft', 'after revocation')`,
      [f.business_id, f.agent_id, thread.rows[0]!.id]
    )
  );

  // ---------------------------------------------------------------------
  // Spec 3 — the stage door: stage_id is closed to direct update; stage
  // changes run only through public.move_engagement_stage(). (These tests
  // must run under the API roles — the superuser bypasses privileges.)
  // ---------------------------------------------------------------------
  console.log("\nSpec 3 — the stage door:");

  const stage2 = await db.query<{ id: string }>(
    `insert into public.stage_definitions (engagement_type_id, key, label, sort_order)
     values ($1, 'contact_attempted', 'Contact attempted', 2) returning id`,
    [f.type_id]
  );
  const stage2Id = stage2.rows[0]!.id;
  const engagementId = engagement.rows[0]!.id;

  await db.exec(`set role authenticated`);
  await db.exec(`set request.jwt.claim.sub = '${ids.user}'`);
  await expectError("a signed-in member cannot update stage_id directly", /permission denied/, () =>
    db.query(`update public.engagements set stage_id = $1 where id = $2`, [stage2Id, engagementId])
  );
  await expectError("stage_entered_at is closed too (timing stays honest)", /permission denied/, () =>
    db.query(`update public.engagements set stage_entered_at = now() where id = $1`, [engagementId])
  );
  await expectOk("other engagement columns remain updatable (title)", () =>
    db.query(`update public.engagements set title = 'Renamed enquiry' where id = $1`, [engagementId])
  );
  await expectError(
    "a signed-in caller cannot move a stage as someone else's actor",
    /own actor/,
    () => db.query(`select public.move_engagement_stage($1, $2, $3)`, [engagementId, stage2Id, f.agent_id])
  );
  await expectOk("move_engagement_stage moves with a grant (the owner)", async () => {
    await db.query(`select public.move_engagement_stage($1, $2, $3)`, [engagementId, stage2Id, f.human_id]);
    const r = await db.query<{ stage_id: string }>(
      `select stage_id from public.engagements where id = $1`,
      [engagementId]
    );
    if (r.rows[0]!.stage_id !== stage2Id) throw new Error("stage_id did not move");
    const h = await db.query<{ n: number }>(
      `select count(*)::int as n from public.stage_history where engagement_id = $1 and to_stage = $2`,
      [engagementId, stage2Id]
    );
    if (h.rows[0]!.n < 1) throw new Error("no stage_history row was appended");
  });
  await db.exec(`reset role`);

  // Server code: service_role carries no JWT subject.
  await db.exec(`set role service_role`);
  await db.exec(`set request.jwt.claim.sub = ''`);
  await expectError("service_role cannot update stage_id directly either", /permission denied/, () =>
    db.query(`update public.engagements set stage_id = $1 where id = $2`, [f.stage_id, engagementId])
  );
  await expectError(
    "move_engagement_stage refuses an ungranted actor (transaction aborts)",
    /enquiries \(execute\)/,
    () => db.query(`select public.move_engagement_stage($1, $2, $3)`, [engagementId, f.stage_id, h2.agent2_id])
  );
  await db.exec(`reset role`);

  await expectOk("the refused move left the engagement untouched", async () => {
    const r = await db.query<{ stage_id: string }>(
      `select stage_id from public.engagements where id = $1`,
      [engagementId]
    );
    if (r.rows[0]!.stage_id !== stage2Id) throw new Error("engagement moved despite the refusal");
  });

  await expectOk("move_engagement_stage moves for a granted agent via server code", () =>
    db.query(`select public.move_engagement_stage($1, $2, $3)`, [engagementId, f.stage_id, f.agent_id])
  );

  // ---------------------------------------------------------------------
  // Session 3 — the Approval Inbox: a view over pending states, readiness
  // pre-flight, and the closed approve/reject pipeline. The Approve control
  // must be earned (Spec 3 §6, decision 11).
  // ---------------------------------------------------------------------
  console.log("\nSpec 3/4 — the approval inbox:");

  // The agent's comms.email grant was revoked above — issue a fresh one for
  // the inbox tests (a change of terms is revoke + new grant, after all).
  await db.query(grantSql, [f.business_id, f.human_id, f.agent_id, "comms.email", "execute", bizScope, "standing", null, f.human_id, "chat"]);

  // A human holding no grants at all: the unauthorised would-be rejecter.
  const human3 = await db.query<{ id: string }>(
    `insert into public.actors (account_id, actor_type, display_name)
     values ($1, 'human', 'Ungranted Human') returning id`,
    [f.account_id]
  );
  const human3Id = human3.rows[0]!.id;

  let pendingCommId = "";
  await expectOk("a fresh Light-style draft is NOT in the inbox (only stamp-awaiting items live there)", async () => {
    const r = await db.query<{ id: string }>(
      `insert into public.communications (business_id, created_by, thread_id, engagement_id, channel, direction, status, body, drafted_by_actor_id)
       values ($1, $2, $3, $4, 'email', 'outbound', 'draft', 'Thank you for your enquiry. Mudassir will call you shortly to talk through your options.', $2) returning id`,
      [f.business_id, f.agent_id, thread.rows[0]!.id, engagementId]
    );
    pendingCommId = r.rows[0]!.id;
    // Session 15: the engine records the compliance check at generation —
    // mirrored here so the submitted draft's pre-flight reads green below.
    await recordCompliance(pendingCommId);
    const v = await db.query<{ n: number }>(
      `select count(*)::int as n from public.approval_inbox where item_id = $1`,
      [pendingCommId]
    );
    if (v.rows[0]!.n !== 0) throw new Error("an unsubmitted draft appeared in the inbox");
  });

  await expectOk("submit_communication moves the draft into the inbox, pre-flight green", async () => {
    await db.query(`select public.submit_communication($1, $2)`, [pendingCommId, f.agent_id]);
    const v = await db.query<{ item_type: string; drafted_by: string; drafted_by_type: string; pass: boolean }>(
      `select item_type, drafted_by, drafted_by_type, preflight_pass as pass
       from public.approval_inbox where item_id = $1`,
      [pendingCommId]
    );
    if (v.rows.length !== 1) throw new Error("submitted draft is not in the inbox");
    if (v.rows[0]!.drafted_by !== "Test Agent") throw new Error(`drafted_by: ${v.rows[0]!.drafted_by}`);
    if (v.rows[0]!.drafted_by_type !== "agent") throw new Error(`drafted_by_type: ${v.rows[0]!.drafted_by_type}`);
    if (!v.rows[0]!.pass) throw new Error("pre-flight is not green");
  });

  await expectError("approve refuses an item that is not stamp-awaiting", /stamp-awaiting/, async () => {
    const r = await db.query<{ id: string }>(
      `insert into public.communications (business_id, created_by, thread_id, channel, direction, status, body, drafted_by_actor_id)
       values ($1, $2, $3, 'email', 'outbound', 'draft', 'Second draft, unsubmitted.', $2) returning id`,
      [f.business_id, f.agent_id, thread.rows[0]!.id]
    );
    await db.query(`select public.approve_communication($1, $2)`, [r.rows[0]!.id, f.human_id]);
  });

  // The approval door is closed like the stage door: status and the approval
  // identity move only through the pipeline. (Run under API roles — the
  // superuser bypasses column privileges.)
  await db.exec(`set role authenticated`);
  await db.exec(`set request.jwt.claim.sub = '${ids.user}'`);
  await expectError("a signed-in member cannot update status directly", /permission denied/, () =>
    db.query(`update public.communications set status = 'approved' where id = $1`, [pendingCommId])
  );
  await expectError("approved_by_actor_id is closed to direct update", /permission denied/, () =>
    db.query(`update public.communications set approved_by_actor_id = $1 where id = $2`, [f.human_id, pendingCommId])
  );
  await expectError("the rejection record is closed to direct update", /permission denied/, () =>
    db.query(`update public.communications set rejection_reason = 'sneaky' where id = $1`, [pendingCommId])
  );
  await expectOk("the body stays editable (Refine is an edit, not a stamp)", () =>
    db.query(`update public.communications set body = body || ' We look forward to speaking with you.' where id = $1`, [pendingCommId])
  );
  // Session 15 / WYSIWYS: the edit above made the recorded compliance check
  // stale — the stamp must refuse the old check and demand a re-screen of
  // exactly these words (the fail-closed edit contract, decision 117).
  await expectError(
    "an edited body cannot ride the old compliance check (WYSIWYS holds)",
    /wording changed/,
    () => db.query(`select public.approve_communication($1, $2)`, [pendingCommId, f.human_id])
  );
  await db.exec(`reset role`);
  await db.exec(`set request.jwt.claim.sub = ''`);
  await recordCompliance(pendingCommId);
  await db.exec(`set role authenticated`);
  await db.exec(`set request.jwt.claim.sub = '${ids.user}'`);
  await expectOk("approve_communication stamps the owner's approval and the item leaves the inbox", async () => {
    await db.query(`select public.approve_communication($1, $2)`, [pendingCommId, f.human_id]);
    const r = await db.query<{ status: string; approved_by_actor_id: string }>(
      `select status, approved_by_actor_id from public.communications where id = $1`,
      [pendingCommId]
    );
    if (r.rows[0]!.status !== "approved") throw new Error(`status is ${r.rows[0]!.status}`);
    if (r.rows[0]!.approved_by_actor_id !== f.human_id) throw new Error("approved_by_actor_id is not the approver");
    const v = await db.query<{ n: number }>(
      `select count(*)::int as n from public.approval_inbox where item_id = $1`,
      [pendingCommId]
    );
    if (v.rows[0]!.n !== 0) throw new Error("an approved item is still in the inbox");
  });
  await db.exec(`reset role`);

  await db.exec(`set role service_role`);
  await db.exec(`set request.jwt.claim.sub = ''`);
  await expectError("service_role cannot update status directly either", /permission denied/, () =>
    db.query(`update public.communications set status = 'approved' where id = $1`, [pendingCommId])
  );
  await db.exec(`reset role`);

  // A second pending draft for the refusal and rejection cases.
  const pending2 = await db.query<{ id: string }>(
    `insert into public.communications (business_id, created_by, thread_id, channel, direction, status, body, drafted_by_actor_id)
     values ($1, $2, $3, 'email', 'outbound', 'draft', 'A first draft that will need another pass.', $2) returning id`,
    [f.business_id, f.agent_id, thread.rows[0]!.id]
  );
  const pending2Id = pending2.rows[0]!.id;
  await db.query(`select public.submit_communication($1, $2)`, [pending2Id, f.agent_id]);

  await expectError(
    "an agent cannot hold the stamp through the pipeline either",
    /approvals\.comms|HUMAN actor/,
    () => db.query(`select public.approve_communication($1, $2)`, [pending2Id, f.agent_id])
  );
  await expectError(
    "a human without approvals.comms cannot reject — refusing the stamp is stamp authority",
    /approvals\.comms/,
    () => db.query(`select public.reject_communication($1, $2, $3)`, [pending2Id, human3Id, "Not good enough."])
  );
  await expectError("rejection requires a reason", /reason/, () =>
    db.query(`select public.reject_communication($1, $2, $3)`, [pending2Id, f.human_id, "   "])
  );
  await expectOk("reject_communication returns the item to the drafter's queue, reason recorded", async () => {
    await db.query(`select public.reject_communication($1, $2, $3)`, [
      pending2Id,
      f.human_id,
      "Tone is off — too formal for a first touch.",
    ]);
    const r = await db.query<{ status: string; rejected_by_actor_id: string; rejection_reason: string }>(
      `select status, rejected_by_actor_id, rejection_reason from public.communications where id = $1`,
      [pending2Id]
    );
    if (r.rows[0]!.status !== "draft") throw new Error(`status is ${r.rows[0]!.status}, not back in the queue`);
    if (r.rows[0]!.rejected_by_actor_id !== f.human_id) throw new Error("rejected_by_actor_id missing");
    if (!/too formal/.test(r.rows[0]!.rejection_reason)) throw new Error("rejection_reason not recorded");
    const v = await db.query<{ n: number }>(
      `select count(*)::int as n from public.approval_inbox where item_id = $1`,
      [pending2Id]
    );
    if (v.rows[0]!.n !== 0) throw new Error("a rejected item is still in the inbox");
  });

  // Readiness pre-flight: each deterministic failure blocks the stamp, and
  // its fix action earns it back.
  const noConsent = await db.query<{ id: string }>(
    `insert into public.contacts (business_id, created_by, type, display_name)
     values ($1, $2, 'person', 'No Consent Contact') returning id`,
    [f.business_id, f.agent_id]
  );
  const ncThread = await db.query<{ id: string }>(
    `insert into public.comm_threads (business_id, created_by, contact_id, channel)
     values ($1, $2, $3, 'email') returning id`,
    [f.business_id, f.agent_id, noConsent.rows[0]!.id]
  );
  const ncComm = await db.query<{ id: string }>(
    `insert into public.communications (business_id, created_by, thread_id, channel, direction, status, body, drafted_by_actor_id)
     values ($1, $2, $3, 'email', 'outbound', 'draft', 'A message to someone who never consented.', $2) returning id`,
    [f.business_id, f.agent_id, ncThread.rows[0]!.id]
  );
  await db.query(`select public.submit_communication($1, $2)`, [ncComm.rows[0]!.id, f.agent_id]);
  await recordCompliance(ncComm.rows[0]!.id);

  await expectError("pre-flight blocks approval without channel consent", /consent/i, () =>
    db.query(`select public.approve_communication($1, $2)`, [ncComm.rows[0]!.id, f.human_id])
  );
  await expectOk("the fix action earns the stamp: consent recorded, approval lands", async () => {
    await db.query(
      `insert into public.contact_channels (business_id, created_by, contact_id, channel, value, is_primary, consent)
       values ($1, $2, $3, 'email', 'no.consent@example.test', true, '{"transactional": true}'::jsonb)`,
      [f.business_id, f.agent_id, noConsent.rows[0]!.id]
    );
    await db.query(`select public.approve_communication($1, $2)`, [ncComm.rows[0]!.id, f.human_id]);
  });

  const attComm = await db.query<{ id: string }>(
    `insert into public.communications (business_id, created_by, thread_id, channel, direction, status, body, drafted_by_actor_id)
     values ($1, $2, $3, 'email', 'outbound', 'draft', 'Please find attached our letter of engagement for your application.', $2) returning id`,
    [f.business_id, f.agent_id, thread.rows[0]!.id]
  );
  await db.query(`select public.submit_communication($1, $2)`, [attComm.rows[0]!.id, f.agent_id]);
  await recordCompliance(attComm.rows[0]!.id);

  await expectError("pre-flight blocks a referenced attachment that is not attached", /attach/, () =>
    db.query(`select public.approve_communication($1, $2)`, [attComm.rows[0]!.id, f.human_id])
  );
  await expectOk("attaching the file earns the stamp", async () => {
    const file = await db.query<{ id: string }>(
      `insert into public.files (business_id, storage_key, filename, mime_type, size_bytes, sha256, uploaded_by)
       values ($1, 'test/letter_of_engagement.pdf', 'letter_of_engagement.pdf', 'application/pdf', 1024, repeat('a', 64), $2) returning id`,
      [f.business_id, f.agent_id]
    );
    await db.query(
      `insert into public.file_links (business_id, file_id, entity_type, entity_id, role)
       values ($1, $2, 'communication', $3, 'attachment')`,
      [f.business_id, file.rows[0]!.id, attComm.rows[0]!.id]
    );
    await db.query(`select public.approve_communication($1, $2)`, [attComm.rows[0]!.id, f.human_id]);
  });

  await expectError("pre-flight blocks unresolved template variables", /template variable/, async () => {
    const r = await db.query<{ id: string }>(
      `insert into public.communications (business_id, created_by, thread_id, channel, direction, status, body, drafted_by_actor_id)
       values ($1, $2, $3, 'email', 'outbound', 'draft', 'Dear {{first_name}}, thank you for your enquiry.', $2) returning id`,
      [f.business_id, f.agent_id, thread.rows[0]!.id]
    );
    await db.query(`select public.submit_communication($1, $2)`, [r.rows[0]!.id, f.agent_id]);
    await db.query(`select public.approve_communication($1, $2)`, [r.rows[0]!.id, f.human_id]);
  });

  await expectOk("pending content and awaiting-approval tasks surface in the same inbox", async () => {
    await db.query(
      `insert into public.content_items (business_id, created_by, content_type, title, slug, state)
       values ($1, $2, 'email_template', 'Intro email v2', 'intro-email-v2', 'pending_approval')`,
      [f.business_id, f.human_id]
    );
    await db.query(
      `insert into public.tasks (business_id, created_by, engagement_id, title, status, assignee_actor_id)
       values ($1, $2, $3, 'Confirm consultation slot', 'awaiting_approval', $4)`,
      [f.business_id, f.agent_id, engagementId, f.human_id]
    );
    const v = await db.query<{ item_type: string }>(
      `select distinct item_type from public.approval_inbox where business_id = $1`,
      [f.business_id]
    );
    const types = v.rows.map((r) => r.item_type);
    if (!types.includes("content")) throw new Error(`no content item in the inbox (saw: ${types.join(", ")})`);
    if (!types.includes("task")) throw new Error(`no task item in the inbox (saw: ${types.join(", ")})`);
  });

  // ---------------------------------------------------------------------
  // Session 6 — the workflow engine (Spec 4 §2–3): the definition door,
  // definition/step immutability outside draft, the run state machine,
  // pause/resume/cancel as gated acts, and compressed-time scheduling.
  // ---------------------------------------------------------------------
  console.log("\nSpec 4 — the workflow engine:");

  await expectError(
    "a workflow definition cannot be born active without a human stamp",
    /human stamp/,
    () =>
      db.query(
        `insert into public.workflow_definitions (business_id, created_by, key, template_id, status, description_plain)
         values ($1, $2, 'wf_unstamped', $3, 'active', 'Should never activate.')`,
        [f.business_id, f.human_id, f.template_id]
      )
  );

  await expectError(
    "an agent cannot hold the workflow stamp (the AI cannot approve automation)",
    /HUMAN actor/,
    () =>
      db.query(
        `insert into public.workflow_definitions (business_id, created_by, key, template_id, status, description_plain, approved_by_actor_id)
         values ($1, $2, 'wf_agent_stamp', $3, 'active', 'Agent-stamped.', $4)`,
        [f.business_id, f.agent_id, f.template_id, f.agent_id]
      )
  );

  await expectError(
    "a human without approvals.workflows cannot activate a definition",
    /approvals\.workflows/,
    () =>
      db.query(
        `insert into public.workflow_definitions (business_id, created_by, key, template_id, status, description_plain, approved_by_actor_id)
         values ($1, $2, 'wf_ungranted_stamp', $3, 'active', 'Ungranted human stamp.', $4)`,
        [f.business_id, f.human_id, f.template_id, h2.human2_id]
      )
  );

  let proposedDefId = "";
  await expectOk("an agent proposes a workflow: it lands in the approval inbox in plain English", async () => {
    const r = await db.query<{ id: string }>(
      `insert into public.workflow_definitions (business_id, created_by, key, template_id, trigger, status, description_plain)
       values ($1, $2, 'wf_agent_proposal', $3, '{"action":"engagement.created"}'::jsonb, 'pending_approval',
               'When a new enquiry arrives, draft a thank-you email for your approval.') returning id`,
      [f.business_id, f.agent_id, f.template_id]
    );
    proposedDefId = r.rows[0]!.id;
    const v = await db.query<{ item_type: string; preview: string; drafted_by_type: string }>(
      `select item_type, preview, drafted_by_type from public.approval_inbox where item_id = $1`,
      [proposedDefId]
    );
    if (v.rows.length !== 1) throw new Error("proposed definition is not in the inbox");
    if (v.rows[0]!.item_type !== "workflow_definition") throw new Error(`item_type: ${v.rows[0]!.item_type}`);
    if (!/thank-you email/.test(v.rows[0]!.preview)) throw new Error("description_plain is not the preview");
    if (v.rows[0]!.drafted_by_type !== "agent") throw new Error("proposer attribution lost");
  });

  await expectError(
    "the proposing agent cannot approve its own workflow through the pipeline",
    /HUMAN actor/,
    () => db.query(`select public.approve_workflow_definition($1, $2)`, [proposedDefId, f.agent_id])
  );

  await expectError("rejecting a workflow proposal requires a reason", /reason/, () =>
    db.query(`select public.reject_workflow_definition($1, $2, '  ')`, [proposedDefId, f.human_id])
  );

  await expectOk("the owner's stamp activates the proposal and it leaves the inbox", async () => {
    await db.query(`select public.approve_workflow_definition($1, $2)`, [proposedDefId, f.human_id]);
    const r = await db.query<{ status: string; approved_by_actor_id: string }>(
      `select status, approved_by_actor_id from public.workflow_definitions where id = $1`,
      [proposedDefId]
    );
    if (r.rows[0]!.status !== "active") throw new Error(`status is ${r.rows[0]!.status}`);
    if (r.rows[0]!.approved_by_actor_id !== f.human_id) throw new Error("stamp not recorded");
    const v = await db.query<{ n: number }>(
      `select count(*)::int as n from public.approval_inbox where item_id = $1`,
      [proposedDefId]
    );
    if (v.rows[0]!.n !== 0) throw new Error("an activated definition is still in the inbox");
  });

  await expectError(
    "definition status never moves by direct update, even for the superuser",
    /moves only through/,
    () => db.query(`update public.workflow_definitions set status = 'paused' where id = $1`, [proposedDefId])
  );

  await db.exec(`set role authenticated`);
  await db.exec(`set request.jwt.claim.sub = '${ids.user}'`);
  await expectError("a signed-in member cannot update definition status directly", /permission denied/, () =>
    db.query(`update public.workflow_definitions set status = 'paused' where id = $1`, [proposedDefId])
  );
  await db.exec(`reset role`);
  await db.exec(`set request.jwt.claim.sub = ''`);

  await expectError(
    "an active definition's behaviour is immutable — a change is a new version",
    /immutable|new version/,
    () =>
      db.query(`update public.workflow_definitions set trigger = '{"action":"contact.created"}'::jsonb where id = $1`, [
        proposedDefId,
      ])
  );

  await expectError("steps cannot be added to a non-draft definition", /immutable|new version/, () =>
    db.query(
      `insert into public.workflow_steps (business_id, created_by, definition_id, key, sort_order, kind)
       values ($1, $2, $3, 'sneaky_step', 1, 'wait')`,
      [f.business_id, f.human_id, proposedDefId]
    )
  );

  // A runnable definition: draft → steps → submit → approve. Waits carry
  // REAL-WORLD durations in config; the runner scales them via timeScale().
  const WAIT_REAL_MS = 2 * 24 * 60 * 60 * 1000; // the spec's T+2d nurture wait
  const engineDef = await db.query<{ id: string }>(
    `insert into public.workflow_definitions (business_id, created_by, key, template_id, trigger, status, description_plain)
     values ($1, $2, 'wf_engine_test', $3, '{"action":"engagement.created"}'::jsonb, 'draft',
             'Draft an email, wait two days, then close.') returning id`,
    [f.business_id, f.human_id, f.template_id]
  );
  const engineDefId = engineDef.rows[0]!.id;
  const stepRows = await db.query<{ id: string; key: string }>(
    `insert into public.workflow_steps (business_id, created_by, definition_id, key, sort_order, kind, config, gate_level)
     values
       ($1, $2, $3, 'draft_email', 1, 'draft_comm', '{"template":"intro_v1","channel":"email"}'::jsonb, 3),
       ($1, $2, $3, 'wait_2d', 2, 'wait', '{"wait":{"days":2}}'::jsonb, 0),
       ($1, $2, $3, 'auto_close', 3, 'close', '{"stage":"unresponsive"}'::jsonb, 2)
     returning id, key`,
    [f.business_id, f.human_id, engineDefId]
  );
  const stepId = new Map(stepRows.rows.map((r) => [r.key, r.id]));

  await expectError("start_workflow_run refuses a definition that is not active", /active/, () =>
    db.query(`select public.start_workflow_run($1, $2, $3)`, [engineDefId, engagementId, f.agent_id])
  );

  await db.query(`select public.submit_workflow_definition($1, $2)`, [engineDefId, f.human_id]);
  await db.query(`select public.approve_workflow_definition($1, $2)`, [engineDefId, f.human_id]);

  await db.exec(`set role authenticated`);
  await db.exec(`set request.jwt.claim.sub = '${ids.user}'`);
  // Two layers refuse this: execute is granted to service_role alone, and the
  // function itself rejects any caller carrying a JWT subject.
  await expectError("engine functions refuse a signed-in session (server only)", /server|permission denied/, () =>
    db.query(`select public.claim_due_step_runs()`)
  );
  await db.exec(`reset role`);
  await db.exec(`set request.jwt.claim.sub = ''`);

  const triggerEventId = event.rows[0]!.id;
  let runId = "";
  await expectOk("start_workflow_run creates the run and schedules the first step immediately", async () => {
    const r = await db.query<{ id: string }>(
      `select public.start_workflow_run($1, $2, $3, $4) as id`,
      [engineDefId, engagementId, f.agent_id, triggerEventId]
    );
    runId = r.rows[0]!.id;
    const run = await db.query<{ status: string; current_step: string }>(
      `select status, current_step from public.workflow_runs where id = $1`,
      [runId]
    );
    if (run.rows[0]!.status !== "waiting") throw new Error(`run status ${run.rows[0]!.status}`);
    if (run.rows[0]!.current_step !== stepId.get("draft_email")) throw new Error("current_step is not step 1");
    const due = await db.query<{ n: number }>(
      `select count(*)::int as n from public.step_runs where run_id = $1 and status = 'scheduled' and scheduled_for <= now()`,
      [runId]
    );
    if (due.rows[0]!.n !== 1) throw new Error("first step is not scheduled now");
  });

  await expectError(
    "a second live run for the same engagement and definition is refused (cron retries cannot double-start)",
    /duplicate key|workflow_runs_one_live_uniq/,
    () => db.query(`select public.start_workflow_run($1, $2, $3)`, [engineDefId, engagementId, f.agent_id])
  );

  // A second engagement for the trigger-idempotency and gated-acts cases.
  const engagement2 = await db.query<{ id: string }>(
    `insert into public.engagements (business_id, created_by, template_type_id, title, stage_id, owner_actor_id)
     values ($1, $2, $3, 'Second enquiry', $4, $5) returning id`,
    [f.business_id, f.agent_id, f.type_id, f.stage_id, f.human_id]
  );
  const engagement2Id = engagement2.rows[0]!.id;

  await expectError(
    "a triggering event is consumed at most once, ever (webhook replays start nothing)",
    /duplicate key|workflow_runs_trigger_event_uniq/,
    () => db.query(`select public.start_workflow_run($1, $2, $3, $4)`, [engineDefId, engagement2Id, f.agent_id, triggerEventId])
  );

  await expectOk("claim → complete schedules the wait step at COMPRESSED time (timers are data × TIME_SCALE)", async () => {
    const claimed = await db.query<{ id: string; step_id: string }>(
      `select id, step_id from public.claim_due_step_runs()`
    );
    const mine = claimed.rows.find((r) => r.step_id === stepId.get("draft_email"));
    if (!mine) throw new Error("the due first step was not claimed");
    const scaledMs = scaleDurationMs(WAIT_REAL_MS); // 2 days @ 1440 → 2 minutes
    if (Math.round(scaledMs) !== 2 * 60 * 1000) throw new Error(`unexpected scale: ${scaledMs}ms`);
    const nextAt = new Date(Date.now() + scaledMs).toISOString();
    const next = await db.query<{ id: string }>(
      `select public.complete_step_run($1, 'completed', '{"communication_id":null}'::jsonb, $2, $3) as id`,
      [mine.id, stepId.get("wait_2d"), nextAt]
    );
    const sched = await db.query<{ delta: number }>(
      `select extract(epoch from (scheduled_for - now()))::int as delta from public.step_runs where id = $1`,
      [next.rows[0]!.id]
    );
    // ~120s out, allowing a few seconds of test runtime.
    if (sched.rows[0]!.delta < 100 || sched.rows[0]!.delta > 125) {
      throw new Error(`wait step scheduled ${sched.rows[0]!.delta}s out — not the compressed 2 minutes`);
    }
    const notDue = await db.query<{ n: number }>(
      `select count(*)::int as n from public.claim_due_step_runs()`
    );
    if (notDue.rows[0]!.n !== 0) throw new Error("a future wait step was claimed early");
  });

  await expectOk("the timer fires when its moment arrives; the final step completes the run", async () => {
    const scaledMs = scaleDurationMs(WAIT_REAL_MS);
    const future = new Date(Date.now() + scaledMs + 5000).toISOString();
    const claimed = await db.query<{ id: string; step_id: string }>(
      `select id, step_id from public.claim_due_step_runs($1)`,
      [future]
    );
    const waitStep = claimed.rows.find((r) => r.step_id === stepId.get("wait_2d"));
    if (!waitStep) throw new Error("the due wait step was not claimed at its compressed moment");
    await db.query(`select public.complete_step_run($1, 'completed', '{}'::jsonb, $2, $3)`, [
      waitStep.id,
      stepId.get("auto_close"),
      future,
    ]);
    const closeClaim = await db.query<{ id: string; step_id: string }>(
      `select id, step_id from public.claim_due_step_runs($1)`,
      [future]
    );
    const closeStep = closeClaim.rows.find((r) => r.step_id === stepId.get("auto_close"));
    if (!closeStep) throw new Error("the close step was not claimed");
    await db.query(`select public.complete_step_run($1, 'completed', '{}'::jsonb)`, [closeStep.id]);
    const run = await db.query<{ status: string }>(`select status from public.workflow_runs where id = $1`, [runId]);
    if (run.rows[0]!.status !== "completed") throw new Error(`run status ${run.rows[0]!.status}`);
  });

  await expectError("a completed run is terminal — it cannot be paused", /live run/, () =>
    db.query(`select public.pause_workflow_run($1, $2)`, [runId, f.human_id])
  );

  // Gated acts on a live run (engagement 2 never consumed its own trigger).
  const runB = await db.query<{ id: string }>(`select public.start_workflow_run($1, $2, $3) as id`, [
    engineDefId,
    engagement2Id,
    f.agent_id,
  ]);
  const runBId = runB.rows[0]!.id;

  await db.exec(`set role authenticated`);
  await db.exec(`set request.jwt.claim.sub = '${ids.member}'`);
  await expectError(
    "a member without enquiries execute cannot pause a workflow run",
    /enquiries \(execute\)/,
    () => db.query(`select public.pause_workflow_run($1, $2)`, [runBId, h2.human2_id])
  );
  await db.exec(`reset role`);
  await db.exec(`set request.jwt.claim.sub = ''`);

  await expectOk("the owner pauses the run; a paused run's timers do not fire", async () => {
    await db.query(`select public.pause_workflow_run($1, $2)`, [runBId, f.human_id]);
    const farFuture = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const claimed = await db.query<{ run_id: string }>(`select run_id from public.claim_due_step_runs($1)`, [farFuture]);
    if (claimed.rows.some((r) => r.run_id === runBId)) throw new Error("a paused run's step was claimed");
  });

  await expectError(
    "a paused run cannot be resurrected by direct update, even by the superuser",
    /gated acts/,
    () => db.query(`update public.workflow_runs set status = 'waiting' where id = $1`, [runBId])
  );

  await expectOk("resume restores the run; cancel is terminal and kills outstanding intents", async () => {
    await db.query(`select public.resume_workflow_run($1, $2)`, [runBId, f.human_id]);
    const resumed = await db.query<{ status: string }>(`select status from public.workflow_runs where id = $1`, [runBId]);
    if (resumed.rows[0]!.status !== "waiting") throw new Error(`resumed status ${resumed.rows[0]!.status}`);
    await db.query(`select public.cancel_workflow_run($1, $2, $3)`, [runBId, f.human_id, "Demo reset."]);
    const open = await db.query<{ n: number }>(
      `select count(*)::int as n from public.step_runs where run_id = $1 and status in ('scheduled','running','awaiting_approval')`,
      [runBId]
    );
    if (open.rows[0]!.n !== 0) throw new Error("cancel left live step intents behind");
  });

  await expectError("a cancelled run is terminal — it cannot be resumed", /paused run/, () =>
    db.query(`select public.resume_workflow_run($1, $2)`, [runBId, f.human_id])
  );

  await expectError(
    "tasks.workflow_run_id must reference a real run (Spec 1's reserved column is now closed)",
    /tasks_workflow_run_fkey|foreign key/,
    () =>
      db.query(
        `insert into public.tasks (business_id, created_by, title, assignee_actor_id, workflow_run_id)
         values ($1, $2, 'Orphan workflow task', $2, '00000000-0000-4000-8000-00000000dead')`,
        [f.business_id, f.human_id]
      )
  );

  await expectError("a message template cannot have an empty body", /message_templates_body_check|check constraint/, () =>
    db.query(
      `insert into public.message_templates (business_id, created_by, key, channel, body)
       values ($1, $2, 'empty_v1', 'email', '   ')`,
      [f.business_id, f.human_id]
    )
  );

  await expectOk("the same template key re-issues as a new version, never a rewrite", async () => {
    await db.query(
      `insert into public.message_templates (business_id, created_by, key, channel, subject, body)
       values ($1, $2, 'intro_v1', 'email', 'Your enquiry', 'Thank you {{first_name}}.')`,
      [f.business_id, f.human_id]
    );
    try {
      await db.query(
        `insert into public.message_templates (business_id, created_by, key, channel, subject, body)
         values ($1, $2, 'intro_v1', 'email', 'Your enquiry', 'Different body, same version.')`,
        [f.business_id, f.human_id]
      );
      throw new Error("duplicate key+version was accepted");
    } catch (err) {
      if (!/duplicate key|message_templates_key_version_uniq/.test(String(err))) throw err;
    }
    await db.query(
      `insert into public.message_templates (business_id, created_by, key, channel, subject, body, version)
       values ($1, $2, 'intro_v1', 'email', 'Your enquiry', 'Warmer second pass, {{first_name}}.', 2)`,
      [f.business_id, f.human_id]
    );
  });

  // RLS: tenancy walls
  console.log("\nRow-Level Security:");
  await db.exec(`set role authenticated`);
  await db.exec(`set request.jwt.claim.sub = '${ids.user}'`);
  await expectOk("member sees their business's contacts", async () => {
    // Two fixtures by now: Test Person and the pre-flight No Consent Contact.
    const r = await db.query<{ n: number }>(`select count(*)::int as n from public.contacts`);
    if (r.rows[0]!.n !== 2) throw new Error(`expected 2 contacts, saw ${r.rows[0]!.n}`);
  });
  await expectError("member cannot hard-delete (no DELETE policy)", /no result|violates|denied|permission/i, async () => {
    const r = await db.query<{ n: number }>(
      `with d as (delete from public.contacts returning 1) select count(*)::int as n from d`
    );
    if (r.rows[0]!.n === 0) throw new Error("permission: delete removed no rows (policy denied)");
  });

  await db.exec(`set request.jwt.claim.sub = '${ids.stranger}'`);
  await expectOk("a stranger sees nothing", async () => {
    for (const table of [
      "contacts", "engagements", "events", "businesses", "tasks", "grants", "approval_inbox",
      "workflow_definitions", "workflow_steps", "workflow_runs", "step_runs", "message_templates",
    ]) {
      const r = await db.query<{ n: number }>(`select count(*)::int as n from public.${table}`);
      if (r.rows[0]!.n !== 0) throw new Error(`${table}: expected 0 rows, saw ${r.rows[0]!.n}`);
    }
  });
  await expectError("a stranger cannot insert into another business", /violates row-level security/, () =>
    db.query(
      `insert into public.contacts (business_id, created_by, type, display_name)
       values ($1, $2, 'person', 'Intruder')`,
      [f.business_id, f.agent_id]
    )
  );
  await db.exec(`reset role`);

  // ---------------------------------------------------------------------
  // Session 5 — the sign-in allowlist: a signed-in user reads exactly one
  // fact (their own live row); managing the list is service-role only.
  // ---------------------------------------------------------------------
  console.log("\nSession 5 — the sign-in allowlist:");

  await expectError("allowlist emails must be lower-case", /allowed_emails_email_is_lower/, () =>
    db.query(`insert into public.allowed_emails (email) values ('Owner@Example.test')`)
  );
  await expectError("an allowlist row must look like an email", /allowed_emails_email_shape/, () =>
    db.query(`insert into public.allowed_emails (email) values ('not-an-email')`)
  );
  await db.query(
    `insert into public.allowed_emails (email, note) values ('owner@example.test', 'test owner')`
  );
  await expectError("the same email cannot be allowlisted twice", /allowed_emails_email_uniq|duplicate/, () =>
    db.query(`insert into public.allowed_emails (email) values ('owner@example.test')`)
  );

  await db.exec(`set role authenticated`);
  await db.exec(`set request.jwt.claim.sub = '${ids.user}'`);
  await db.exec(`set request.jwt.claims = '{"sub":"${ids.user}","email":"owner@example.test"}'`);
  await expectOk("an allowlisted user sees their own row — the door opens", async () => {
    const r = await db.query<{ n: number }>(`select count(*)::int as n from public.allowed_emails`);
    if (r.rows[0]!.n !== 1) throw new Error(`expected 1 row, saw ${r.rows[0]!.n}`);
  });
  await expectError("a signed-in user cannot allowlist anyone", /violates row-level security|permission denied/, () =>
    db.query(`insert into public.allowed_emails (email) values ('friend@example.test')`)
  );
  await expectError("a signed-in user cannot edit their own row", /no result|permission/i, async () => {
    const r = await db.query<{ n: number }>(
      `with u as (update public.allowed_emails set note = 'promoted myself' returning 1)
       select count(*)::int as n from u`
    );
    if (r.rows[0]!.n === 0) throw new Error("permission: update touched no rows (no policy)");
  });

  await db.exec(`set request.jwt.claim.sub = '${ids.member}'`);
  await db.exec(`set request.jwt.claims = '{"sub":"${ids.member}","email":"member@example.test"}'`);
  await expectOk("a signed-in but non-allowlisted user sees nothing — the door stays shut", async () => {
    const r = await db.query<{ n: number }>(`select count(*)::int as n from public.allowed_emails`);
    if (r.rows[0]!.n !== 0) throw new Error(`expected 0 rows, saw ${r.rows[0]!.n}`);
  });
  await db.exec(`reset role`);

  await expectOk("archiving an allowlist row revokes access without deleting the record", async () => {
    await db.query(`update public.allowed_emails set archived_at = now() where email = 'owner@example.test'`);
    await db.exec(`set role authenticated`);
    await db.exec(`set request.jwt.claim.sub = '${ids.user}'`);
    await db.exec(`set request.jwt.claims = '{"sub":"${ids.user}","email":"owner@example.test"}'`);
    const r = await db.query<{ n: number }>(`select count(*)::int as n from public.allowed_emails`);
    await db.exec(`reset role`);
    if (r.rows[0]!.n !== 0) throw new Error(`an archived row is still visible (${r.rows[0]!.n})`);
  });

  // ---------------------------------------------------------------------
  console.log("\nSession 9 — onboarding foundations:");

  // --- Stripe webhook signature (DoD ③'s core) — pure TS, no credential ---
  const whSecret = "whsec_smoke_test_secret";
  const whBody = JSON.stringify({ id: "evt_smoke_1", type: "checkout.session.completed" });
  const whNowMs = Date.now();
  const whTs = Math.floor(whNowMs / 1000);
  const signAt = (ts: number, body: string) =>
    createHmac("sha256", whSecret).update(`${ts}.${body}`).digest("hex");

  await expectOk("a correctly signed Stripe webhook body verifies", async () => {
    const r = verifyStripeSignature({
      payload: whBody, header: `t=${whTs},v1=${signAt(whTs, whBody)}`, secret: whSecret, nowMs: whNowMs,
    });
    if (!r.ok) throw new Error(r.reason);
  });
  await expectOk("a tampered webhook body is refused", async () => {
    const r = verifyStripeSignature({
      payload: whBody + " ", header: `t=${whTs},v1=${signAt(whTs, whBody)}`, secret: whSecret, nowMs: whNowMs,
    });
    if (r.ok) throw new Error("a tampered body verified");
  });
  await expectOk("a stale signature timestamp is refused (replay window)", async () => {
    const stale = whTs - 3600;
    const r = verifyStripeSignature({
      payload: whBody, header: `t=${stale},v1=${signAt(stale, whBody)}`, secret: whSecret, nowMs: whNowMs,
    });
    if (r.ok) throw new Error("a signature an hour old verified");
  });
  await expectOk("a missing Stripe-Signature header is refused", async () => {
    const r = verifyStripeSignature({ payload: whBody, header: null, secret: whSecret, nowMs: whNowMs });
    if (r.ok) throw new Error("no header verified");
  });

  // --- stripe_events: idempotency on the provider's id --------------------
  await db.query(
    `insert into public.stripe_events (stripe_event_id, type, payload) values ('evt_smoke_1', 'checkout.session.completed', '{}')`
  );
  await expectError(
    "replaying the same Stripe event id changes nothing (webhook idempotency)",
    /stripe_events_stripe_event_id_uniq|duplicate/,
    () =>
      db.query(
        `insert into public.stripe_events (stripe_event_id, type, payload) values ('evt_smoke_1', 'checkout.session.completed', '{}')`
      )
  );
  await expectOk("raw provider payloads are invisible to signed-in users", async () => {
    await db.exec(`set role authenticated`);
    await db.exec(`set request.jwt.claim.sub = '${ids.user}'`);
    const r = await db.query<{ n: number }>(`select count(*)::int as n from public.stripe_events`);
    await db.exec(`reset role`);
    if (r.rows[0]!.n !== 0) throw new Error(`a signed-in user read ${r.rows[0]!.n} provider payload(s)`);
  });

  // --- the activation door -------------------------------------------------
  const ownerUserId = "00000000-0000-4000-8000-000000000009";
  await db.query(`insert into auth.users (id, email) values ($1, 'aisha@jurists.test')`, [ownerUserId]);
  const signup = await db.query<{ id: string }>(
    `insert into public.accounts (name, billing_status, signup_business_name, signup_email, signup_phone, signup_website_url)
     values ('Aisha Test', 'pre_active', 'Jurists', 'aisha@jurists.test', '+441610000000', 'https://jurists.test')
     returning id`
  );
  const signupId = signup.rows[0]!.id;

  await expectError(
    "a signed-in user cannot open the activation door (service-role only)",
    /permission denied/,
    async () => {
      await db.exec(`set role authenticated`);
      try {
        await db.query(`select public.activate_signup($1, $2, 'cus_x', 'sub_x')`, [signupId, ownerUserId]);
      } finally {
        await db.exec(`reset role`);
      }
    }
  );

  let activation: {
    business_id: string; owner_actor_id: string; light_actor_id: string; stripe_actor_id: string;
  };
  await expectOk("payment activates the account: business, actors, membership, allowlist, grants, First Light rows — one act", async () => {
    const r = await db.query<{ out: typeof activation & { already_active: boolean } }>(
      `select public.activate_signup($1, $2, 'cus_smoke_1', 'sub_smoke_1') as out`,
      [signupId, ownerUserId]
    );
    activation = r.rows[0]!.out;
    if ((r.rows[0]!.out as { already_active: boolean }).already_active) throw new Error("fresh signup reported already_active");

    const checks = await db.query<{ label: string; n: number }>(
      `select 'business' as label, count(*)::int as n from public.businesses where account_id = $1 and website_url = 'https://jurists.test'
       union all select 'actors', count(*)::int from public.actors where account_id = $1
       union all select 'membership', count(*)::int from public.memberships where user_id = $2 and role = 'owner'
       union all select 'allowlist', count(*)::int from public.allowed_emails where email = 'aisha@jurists.test' and archived_at is null
       union all select 'grants', count(*)::int from public.grants g join public.businesses b on b.id = g.business_id where b.account_id = $1
       union all select 'tasks', count(*)::int from public.tasks t join public.businesses b on b.id = t.business_id where b.account_id = $1 and (t.attributes ->> 'first_light')::boolean
       union all select 'predicates', count(*)::int from public.first_light_predicates p join public.businesses b on b.id = p.business_id where b.account_id = $1
       union all select 'optional', count(*)::int from public.first_light_predicates p join public.businesses b on b.id = p.business_id where b.account_id = $1 and p.optional`,
      [signupId, ownerUserId]
    );
    // Session 11: activation additionally creates the workflow engine actor
    // (dispatch attribution + the Contacted transition need it) and its
    // enquiries grant — 3 actors/grants became 4.
    const expected: Record<string, number> = {
      business: 1, actors: 4, membership: 1, allowlist: 1, grants: 4, tasks: 8, predicates: 8, optional: 1,
    };
    for (const row of checks.rows) {
      if (row.n !== expected[row.label]) {
        throw new Error(`${row.label}: expected ${expected[row.label]}, got ${row.n}`);
      }
    }
    const acc = await db.query<{ billing_status: string; plan: string; activated_at: string | null }>(
      `select billing_status, plan, activated_at from public.accounts where id = $1`, [signupId]
    );
    const a = acc.rows[0]!;
    if (a.billing_status !== "active" || a.plan !== "pilot_firm" || !a.activated_at) {
      throw new Error(`account not activated: ${JSON.stringify(a)}`);
    }
  });

  await expectOk("activation is idempotent — a replayed webhook re-creates nothing", async () => {
    const r = await db.query<{ out: { already_active: boolean } }>(
      `select public.activate_signup($1, $2, 'cus_smoke_1', 'sub_smoke_1') as out`,
      [signupId, ownerUserId]
    );
    if (!r.rows[0]!.out.already_active) throw new Error("second activation did not report already_active");
    const n = await db.query<{ n: number }>(
      `select count(*)::int as n from public.tasks t join public.businesses b on b.id = t.business_id where b.account_id = $1`,
      [signupId]
    );
    if (n.rows[0]!.n !== 8) throw new Error(`task rows after replay: ${n.rows[0]!.n}`);
  });

  // The grant set applied at activation is real enforcement, not decoration:
  // Light passes the 0015 Level 2 gate; the ungranted Stripe actor is refused.
  await expectOk("Light's activation grant lets it create further tasks (the 0015 gate consumes it)", async () => {
    await db.query(
      `insert into public.tasks (business_id, created_by, title, status, assignee_actor_id)
       values ($1, $2, 'Light follow-up', 'open', $3)`,
      [activation!.business_id, activation!.light_actor_id, activation!.owner_actor_id]
    );
  });
  await expectError(
    "the ungranted Stripe actor cannot create tasks — activation granted exactly what was ruled",
    /enquiries \(execute\)/,
    () =>
      db.query(
        `insert into public.tasks (business_id, created_by, title, status, assignee_actor_id)
         values ($1, $2, 'Stripe should not do this', 'open', $3)`,
        [activation!.business_id, activation!.stripe_actor_id, activation!.owner_actor_id]
      )
  );

  await expectError(
    "the deletion door refuses an activated account",
    /not a pre-active signup/,
    () => db.query(`select public.delete_unpaid_signup($1)`, [signupId])
  );
  await expectOk("the refused deletion left the activated account untouched", async () => {
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from public.accounts where id = $1 and billing_status = 'active'`,
      [signupId]
    );
    if (r.rows[0]!.n !== 1) throw new Error("the activated account is gone or changed");
  });

  // --- the deletion door, permitted path ----------------------------------
  const unpaid = await db.query<{ id: string }>(
    `insert into public.accounts (name, billing_status, signup_business_name, signup_email)
     values ('Ghost Signup', 'pre_active', 'Ghost Ltd', 'ghost@example.test') returning id`
  );
  await expectOk("the 30-day sweep hard-deletes a pre-active signup", async () => {
    const r = await db.query<{ ok: boolean }>(`select public.delete_unpaid_signup($1) as ok`, [
      unpaid.rows[0]!.id,
    ]);
    if (!r.rows[0]!.ok) throw new Error("deletion door returned false");
    const n = await db.query<{ n: number }>(
      `select count(*)::int as n from public.accounts where id = $1`,
      [unpaid.rows[0]!.id]
    );
    if (n.rows[0]!.n !== 0) throw new Error("the pre-active row survived");
  });

  // --- platform-scope events (decision 26's revisit trigger, ruled) --------
  await expectOk("account.deleted_unpaid lands at platform scope (null business, platform actor)", async () => {
    await db.query(
      `insert into public.events (business_id, actor_id, action, entity_type, entity_id, payload)
       values (null, 'b0000000-0000-4000-8000-000000000001', 'account.deleted_unpaid', 'account', $1, '{}')`,
      [unpaid.rows[0]!.id]
    );
  });
  await expectError(
    "platform scope is lawful ONLY for the account.* namespace",
    /events_platform_scope_account_namespace/,
    () =>
      db.query(
        `insert into public.events (business_id, actor_id, action)
         values (null, 'b0000000-0000-4000-8000-000000000001', 'contact.created')`
      )
  );
  await expectOk("platform-scope events are invisible to every signed-in user", async () => {
    await db.exec(`set role authenticated`);
    await db.exec(`set request.jwt.claim.sub = '${ids.user}'`);
    await db.exec(`set request.jwt.claims = '{"sub":"${ids.user}","email":"owner@example.test"}'`);
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from public.events where business_id is null`
    );
    await db.exec(`reset role`);
    if (r.rows[0]!.n !== 0) throw new Error(`a tenant read ${r.rows[0]!.n} platform event(s)`);
  });

  // --- first_light_predicates: earned ticks only ---------------------------
  const predicate = await db.query<{ id: string }>(
    `select id from public.first_light_predicates where business_id = $1 and predicate_key = 'sending_domain_verified'`,
    [activation!.business_id]
  );
  await expectError(
    "a predicate cannot flip without its ledger event (an uneventful tick is impossible)",
    /first_light_predicates_flip_is_evented/,
    () =>
      db.query(`update public.first_light_predicates set satisfied_at = now() where id = $1`, [
        predicate.rows[0]!.id,
      ])
  );
  await expectOk("the refused flip left the predicate unsatisfied", async () => {
    const r = await db.query<{ satisfied_at: string | null }>(
      `select satisfied_at from public.first_light_predicates where id = $1`,
      [predicate.rows[0]!.id]
    );
    if (r.rows[0]!.satisfied_at !== null) throw new Error("the predicate flipped despite the refusal");
  });
  await expectOk("a flip paired with its event succeeds (the earned tick)", async () => {
    const evt = await db.query<{ id: string }>(
      `insert into public.events (business_id, actor_id, action, entity_type, entity_id)
       values ($1, $2, 'first_light.predicate_satisfied', 'first_light_predicate', $3) returning id`,
      [activation!.business_id, activation!.light_actor_id, predicate.rows[0]!.id]
    );
    await db.query(
      `update public.first_light_predicates set satisfied_at = now(), satisfied_event_id = $2 where id = $1`,
      [predicate.rows[0]!.id, evt.rows[0]!.id]
    );
  });
  await expectOk("the new owner sees their eight First Light predicates; a stranger sees none", async () => {
    await db.exec(`set role authenticated`);
    await db.exec(`set request.jwt.claim.sub = '${ownerUserId}'`);
    await db.exec(`set request.jwt.claims = '{"sub":"${ownerUserId}","email":"aisha@jurists.test"}'`);
    const own = await db.query<{ n: number }>(
      `select count(*)::int as n from public.first_light_predicates`
    );
    await db.exec(`set request.jwt.claim.sub = '${ids.stranger}'`);
    await db.exec(`set request.jwt.claims = '{"sub":"${ids.stranger}","email":"stranger@example.test"}'`);
    const stranger = await db.query<{ n: number }>(
      `select count(*)::int as n from public.first_light_predicates`
    );
    await db.exec(`reset role`);
    if (own.rows[0]!.n !== 8) throw new Error(`owner sees ${own.rows[0]!.n} predicates, expected 8`);
    if (stranger.rows[0]!.n !== 0) throw new Error(`a stranger sees ${stranger.rows[0]!.n} predicates`);
  });
  await expectOk("a signed-in user cannot self-report a tick (no write policy)", async () => {
    await db.exec(`set role authenticated`);
    await db.exec(`set request.jwt.claim.sub = '${ownerUserId}'`);
    await db.exec(`set request.jwt.claims = '{"sub":"${ownerUserId}","email":"aisha@jurists.test"}'`);
    const r = await db.query<{ n: number }>(
      `with u as (update public.first_light_predicates set satisfied_at = now(), satisfied_event_id = null returning 1)
       select count(*)::int as n from u`
    );
    await db.exec(`reset role`);
    if (r.rows[0]!.n !== 0) throw new Error(`a browser flipped ${r.rows[0]!.n} tick(s)`);
  });

  // ---------------------------------------------------------------------
  // Session 10 — connect to the world: the send-pipeline door (0021), the
  // WhatsApp session-window pre-flight, Meta webhook signature + leadgen
  // idempotency, quiet-hours policy, and the decision-15 auto-close refusal.
  // ---------------------------------------------------------------------
  console.log("\nSession 10 — the send pipeline and the Meta door:");

  // --- Meta webhook signature (verified before parsing, always) — pure TS --
  const metaSecret = "meta_app_secret_smoke";
  const metaBody = JSON.stringify({ object: "page", entry: [{ id: "1", changes: [] }] });
  const metaSig = `sha256=${createHmac("sha256", metaSecret).update(metaBody, "utf8").digest("hex")}`;
  await expectOk("a correctly signed Meta webhook body verifies", async () => {
    const r = verifyMetaSignature({ payload: metaBody, header: metaSig, secret: metaSecret });
    if (!r.ok) throw new Error(r.reason);
  });
  await expectOk("a tampered Meta webhook body is refused", async () => {
    const r = verifyMetaSignature({ payload: metaBody + " ", header: metaSig, secret: metaSecret });
    if (r.ok) throw new Error("a tampered body verified");
  });
  await expectOk("a missing X-Hub-Signature-256 header is refused", async () => {
    const r = verifyMetaSignature({ payload: metaBody, header: null, secret: metaSecret });
    if (r.ok) throw new Error("no header verified");
  });

  // --- meta_webhook_events: idempotency on the provider's leadgen id -------
  await db.query(
    `insert into public.meta_webhook_events (leadgen_id, page_id, payload) values ('444400000000000099', '112233', '{}')`
  );
  await expectError(
    "replaying the same Meta leadgen id changes nothing (webhook idempotency)",
    /meta_webhook_events_leadgen_id_uniq|duplicate/,
    () =>
      db.query(
        `insert into public.meta_webhook_events (leadgen_id, page_id, payload) values ('444400000000000099', '112233', '{}')`
      )
  );
  await expectOk("raw Meta payloads are invisible to signed-in users", async () => {
    await db.exec(`set role authenticated`);
    await db.exec(`set request.jwt.claim.sub = '${ids.user}'`);
    const r = await db.query<{ n: number }>(`select count(*)::int as n from public.meta_webhook_events`);
    await db.exec(`reset role`);
    if (r.rows[0]!.n !== 0) throw new Error(`a signed-in user read ${r.rows[0]!.n} provider payload(s)`);
  });

  // --- quiet hours: wall-clock policy, clock injected (never waited) -------
  await expectOk("a message stamped inside quiet hours holds until 08:00 local", async () => {
    // 20:30 in London (BST, UTC+1) on 17 Jul 2026 = 19:30Z; the window ends
    // at 08:00 local next day = 07:00Z.
    const held = quietHoursHoldUntil(new Date("2026-07-17T19:30:00Z"), "Europe/London", QUIET_HOURS_DEFAULT);
    if (!held) throw new Error("20:30 local was not held");
    if (held.toISOString() !== "2026-07-18T07:00:00.000Z") throw new Error(`held until ${held.toISOString()}`);
  });
  await expectOk("a message stamped in working hours dispatches now", async () => {
    const held = quietHoursHoldUntil(new Date("2026-07-17T11:00:00Z"), "Europe/London", QUIET_HOURS_DEFAULT);
    if (held) throw new Error(`midday was held until ${held.toISOString()}`);
  });
  await expectOk("quiet hours disabled (null) never hold", async () => {
    const held = quietHoursHoldUntil(new Date("2026-07-17T19:30:00Z"), "Europe/London", null);
    if (held) throw new Error("a null window held a message");
  });

  // --- decision 15: the auto-close refusal — pure and clock-free -----------
  await expectOk("auto-close REFUSES when nudges were never approved (drafts died in the inbox)", async () => {
    const v = evaluateAutoClose([
      { communication_id: "a", status: "draft" },
      { communication_id: "b", status: "pending_approval" },
      { communication_id: "c", status: "draft" },
    ]);
    if (v.close) throw new Error("closed an enquiry whose nudges never reached the client");
    if (!/misattribute/.test(v.reason)) throw new Error(`reason does not carry the law: ${v.reason}`);
  });
  await expectOk("auto-close refuses when NO nudges exist on the run", async () => {
    const v = evaluateAutoClose([]);
    if (v.close) throw new Error("closed with zero nudges");
  });
  await expectOk("auto-close proceeds when nudges were genuinely delivered and silence followed", async () => {
    const v = evaluateAutoClose([
      { communication_id: "a", status: "sent" },
      { communication_id: "b", status: "draft" },
    ]);
    if (!v.close) throw new Error(`refused a lawful close: ${v.reason}`);
    if (v.nudges_sent !== 1) throw new Error(`counted ${v.nudges_sent} sent nudges`);
  });

  // --- the send door (0021): approved ≠ sent, service-only, refusal-first --
  await expectError(
    "service_role cannot flip status to sent by direct update (the door stays shut)",
    /permission denied/,
    async () => {
      await db.exec(`set role service_role`);
      try {
        await db.query(`update public.communications set status = 'sent' where id = $1`, [pendingCommId]);
      } finally {
        await db.exec(`reset role`);
      }
    }
  );
  await expectError(
    "mark_communication_sent refuses a signed-in session (dispatch is a server act)",
    /server|permission denied/,
    async () => {
      await db.exec(`set role authenticated`);
      await db.exec(`set request.jwt.claim.sub = '${ids.user}'`);
      try {
        await db.query(`select public.mark_communication_sent($1, 'graph', 'msg-1')`, [pendingCommId]);
      } finally {
        await db.exec(`reset role`);
        await db.exec(`set request.jwt.claim.sub = ''`);
      }
    }
  );
  await expectError(
    "mark_communication_sent refuses an unstamped draft — APPROVED ≠ SENT is structural",
    /APPROVED/,
    async () => {
      const draft = await db.query<{ id: string }>(
        `insert into public.communications (business_id, created_by, thread_id, channel, direction, status, body, drafted_by_actor_id)
         values ($1, $2, $3, 'email', 'outbound', 'draft', 'Never stamped, never sent.', $2) returning id`,
        [f.business_id, f.agent_id, thread.rows[0]!.id]
      );
      await db.query(`select public.mark_communication_sent($1, 'graph', 'msg-x')`, [draft.rows[0]!.id]);
    }
  );
  await expectOk("the permitted path: an approved message becomes sent with its provider id on the row", async () => {
    await db.query(`select public.mark_communication_sent($1, 'graph', '<msg-abc@firm.example>')`, [pendingCommId]);
    const r = await db.query<{ status: string; refs: string }>(
      `select status, external_refs::text as refs from public.communications where id = $1`,
      [pendingCommId]
    );
    if (r.rows[0]!.status !== "sent") throw new Error(`status is ${r.rows[0]!.status}`);
    if (!/msg-abc@firm\.example/.test(r.rows[0]!.refs)) throw new Error("provider message id not on the row");
    if (!/"system": *"graph"/.test(r.rows[0]!.refs)) throw new Error("provider name not on the row");
  });
  await expectError("a sent message cannot be sent twice (replays re-do nothing)", /APPROVED/, () =>
    db.query(`select public.mark_communication_sent($1, 'graph', 'msg-2')`, [pendingCommId])
  );
  await expectError("a failed send requires a reason", /reason/, () =>
    db.query(`select public.mark_communication_send_failed($1, 'graph', '  ')`, [attComm.rows[0]!.id])
  );
  await expectOk("a provider refusal becomes the VISIBLE failed state, reason on the row", async () => {
    await db.query(`select public.mark_communication_send_failed($1, 'graph', 'Mailbox does not exist')`, [
      attComm.rows[0]!.id,
    ]);
    const r = await db.query<{ status: string; failure: string | null }>(
      `select status, attributes -> 'send_failure' ->> 'reason' as failure from public.communications where id = $1`,
      [attComm.rows[0]!.id]
    );
    if (r.rows[0]!.status !== "failed") throw new Error(`status is ${r.rows[0]!.status}`);
    if (r.rows[0]!.failure !== "Mailbox does not exist") throw new Error("failure reason not recorded");
  });
  await expectError("a failed message cannot be marked sent afterwards", /APPROVED/, () =>
    db.query(`select public.mark_communication_sent($1, 'graph', 'msg-3')`, [attComm.rows[0]!.id])
  );

  // --- the WhatsApp session window (pre-flight check 5) --------------------
  await db.query(grantSql, [f.business_id, f.human_id, f.agent_id, "comms.whatsapp", "execute", bizScope, "standing", null, f.human_id, "chat"]);
  const waContact = await db.query<{ id: string }>(
    `insert into public.contacts (business_id, created_by, type, display_name)
     values ($1, $2, 'person', 'WhatsApp Contact') returning id`,
    [f.business_id, f.agent_id]
  );
  await db.query(
    `insert into public.contact_channels (business_id, created_by, contact_id, channel, value, is_primary, consent)
     values ($1, $2, $3, 'whatsapp', '+447700900123', true, '{"transactional": true}'::jsonb)`,
    [f.business_id, f.agent_id, waContact.rows[0]!.id]
  );
  const waThread = await db.query<{ id: string }>(
    `insert into public.comm_threads (business_id, created_by, contact_id, channel)
     values ($1, $2, $3, 'whatsapp') returning id`,
    [f.business_id, f.agent_id, waContact.rows[0]!.id]
  );

  // Session 16: one pending outbound per thread+channel is now law (0030) —
  // each test draft takes its own thread so unresolved pendings from earlier
  // refusal tests cannot collide with later ones.
  const draftWa = async (body: string, attributes: string) => {
    const t = await db.query<{ id: string }>(
      `insert into public.comm_threads (business_id, created_by, contact_id, channel)
       values ($1, $2, $3, 'whatsapp') returning id`,
      [f.business_id, f.agent_id, waContact.rows[0]!.id]
    );
    const r = await db.query<{ id: string }>(
      `insert into public.communications (business_id, created_by, thread_id, contact_id, channel, direction, status, body, drafted_by_actor_id, attributes)
       values ($1, $2, $3, $4, 'whatsapp', 'outbound', 'draft', $5, $2, $6::jsonb) returning id`,
      [f.business_id, f.agent_id, t.rows[0]!.id, waContact.rows[0]!.id, body, attributes]
    );
    await db.query(`select public.submit_communication($1, $2)`, [r.rows[0]!.id, f.agent_id]);
    await recordCompliance(r.rows[0]!.id);
    return r.rows[0]!.id;
  };

  await expectError(
    "a free-form WhatsApp message outside the 24h session window cannot be approved",
    /session window/,
    async () => {
      const id = await draftWa("Just checking in about your enquiry.", "{}");
      await db.query(`select public.approve_communication($1, $2)`, [id, f.human_id]);
    }
  );
  await expectOk("an approved TEMPLATE message passes the window any time", async () => {
    const id = await draftWa(
      "[template] Gentle nudge about your enquiry.",
      JSON.stringify({ wa_template: { name: "nurture_t2_v1", language: "en_GB" } })
    );
    await db.query(`select public.approve_communication($1, $2)`, [id, f.human_id]);
  });
  await expectOk("a customer inbound OPENS the window: free-form becomes approvable", async () => {
    await db.query(
      `insert into public.communications (business_id, created_by, thread_id, contact_id, channel, direction, status, body, occurred_at)
       values ($1, $2, $3, $4, 'whatsapp', 'inbound', 'received', 'Salaam, yes please call me', now() - interval '1 hour')`,
      [f.business_id, f.agent_id, waThread.rows[0]!.id, waContact.rows[0]!.id]
    );
    const id = await draftWa("Thanks — calling you this afternoon.", "{}");
    await db.query(`select public.approve_communication($1, $2)`, [id, f.human_id]);
  });

  // ---------------------------------------------------------------------
  // Session 11 — First Light: template installation (0022), the Contacted
  // transition law, and the nurture bands at compressed time.
  // ---------------------------------------------------------------------
  console.log("\nSession 11 — template installation and the transition law:");

  // --- template_definitions: readable content, re-issue-only writes -------
  await expectOk("the v3 definition ships with the schema and is readable by a signed-in user", async () => {
    await db.exec(`set role authenticated`);
    await db.exec(`set request.jwt.claim.sub = '${ids.user}'`);
    const r = await db.query<{ key: string; version: number; stages: number; nogos: number }>(
      `select key, version,
              jsonb_array_length(definition -> 'engagement_types' -> 0 -> 'stages')::int as stages,
              jsonb_array_length(definition -> 'no_go_rules')::int as nogos
       from public.template_definitions where key = 'uk_immigration_advisory'`
    );
    await db.exec(`reset role`);
    const d = r.rows[0];
    if (!d) throw new Error("no definition row visible");
    if (d.version !== 3 || d.stages !== 10 || d.nogos !== 4) {
      throw new Error(`definition is not v3/10 stages/4 no-gos: ${JSON.stringify(d)}`);
    }
  });
  await expectError(
    "a signed-in user cannot write a template definition (re-issue by migration only)",
    /row-level security|permission denied/,
    async () => {
      await db.exec(`set role authenticated`);
      await db.exec(`set request.jwt.claim.sub = '${ids.user}'`);
      try {
        await db.query(
          `insert into public.template_definitions (key, version, display_name) values ('rogue', 1, 'Rogue')`
        );
      } finally {
        await db.exec(`reset role`);
      }
    }
  );

  // --- activation installs the template ------------------------------------
  let installedTypeId = "";
  let installedNewLeadId = "";
  let installedContactedId = "";
  await expectOk("activation installed UK Immigration Advisory v3 — businesses.template_id is real", async () => {
    const r = await db.query<{ template_id: string | null; vertical: string; version: number; nogos: number }>(
      `select b.template_id, t.vertical, t.version, jsonb_array_length(t.no_go_rules)::int as nogos
       from public.businesses b join public.templates t on t.id = b.template_id
       where b.id = $1`,
      [activation!.business_id]
    );
    const row = r.rows[0];
    if (!row?.template_id) throw new Error("businesses.template_id is null after activation");
    if (row.vertical !== "uk_immigration_advisory" || row.version !== 3 || row.nogos !== 4) {
      throw new Error(`installed template is not v3 with the four no-gos: ${JSON.stringify(row)}`);
    }
  });
  await expectOk("the installed stage set is the v3 semantic set — Contacted in, pending_qualification out", async () => {
    const r = await db.query<{ id: string; key: string; label: string; is_terminal: boolean; terminal_outcome: string | null; engagement_type_id: string }>(
      `select s.id, s.key, s.label, s.is_terminal, s.terminal_outcome, s.engagement_type_id
       from public.stage_definitions s
       join public.engagement_types et on et.id = s.engagement_type_id
       join public.businesses b on b.template_id = et.template_id
       where b.id = $1
       order by s.sort_order`,
      [activation!.business_id]
    );
    const keys = r.rows.map((s) => s.key);
    const expectedKeys = [
      "new_lead", "contacted", "qualified", "consultation_booked", "consultation_held",
      "instructed", "won", "closed_lost", "unresponsive", "disqualified",
    ];
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
      throw new Error(`stage keys: ${keys.join(", ")}`);
    }
    const byKey = Object.fromEntries(r.rows.map((s) => [s.key, s]));
    if (byKey.new_lead!.label !== "New") throw new Error(`new_lead label: ${byKey.new_lead!.label}`);
    if (byKey.contacted!.label !== "Contacted") throw new Error(`contacted label: ${byKey.contacted!.label}`);
    if (byKey.instructed!.is_terminal) throw new Error("instructed is terminal — v3 splits instructed from won");
    if (byKey.won!.terminal_outcome !== "won") throw new Error("won is not the won-terminal");
    installedTypeId = byKey.new_lead!.engagement_type_id;
    installedNewLeadId = byKey.new_lead!.id;
    installedContactedId = byKey.contacted!.id;
  });
  await expectOk("vocabulary and field definitions installed from the definition", async () => {
    const r = await db.query<{ label: string; n: number }>(
      `select 'vocab' as label, count(*)::int as n from public.vocabulary v
         join public.businesses b on b.template_id = v.template_id where b.id = $1
       union all
       select 'fields', count(*)::int from public.field_definitions fd
         join public.businesses b on b.template_id = fd.template_id where b.id = $1`,
      [activation!.business_id]
    );
    for (const row of r.rows) {
      // Session 15 (0024): the definition's five field declarations plus the
      // three drafting declarations (knowledge category, content route,
      // engagement form_answers) — installed from birth.
      const want = row.label === "vocab" ? 5 : 8;
      if (row.n !== want) throw new Error(`${row.label}: expected ${want}, got ${row.n}`);
    }
  });

  // --- the Contacted transition law (0022 trigger) -------------------------
  // Machinery on the activated business: v3 stages, Light's comms grant, the
  // workflow actor. Seed → stamp → observe: the stamp alone must NOT move
  // the stage; the genuine dispatch must.
  await db.exec(`set request.jwt.claim.sub = ''`); // server path: no signed-in subject
  const tlContact = await db.query<{ id: string }>(
    `insert into public.contacts (business_id, created_by, type, display_name)
     values ($1, $2, 'person', 'Transition Lead') returning id`,
    [activation!.business_id, activation!.light_actor_id]
  );
  await db.query(
    `insert into public.contact_channels (business_id, created_by, contact_id, channel, value, is_primary, consent)
     values ($1, $2, $3, 'email', 'transition@lead.test', true, '{"transactional": true}'::jsonb)`,
    [activation!.business_id, activation!.light_actor_id, tlContact.rows[0]!.id]
  );
  const tlEngagement = await db.query<{ id: string }>(
    `insert into public.engagements (business_id, created_by, template_type_id, title, stage_id, stage_entered_at, owner_actor_id)
     values ($1, $2, $3, 'Transition Lead — enquiry', $4, now(), $5) returning id`,
    [activation!.business_id, activation!.light_actor_id, installedTypeId, installedNewLeadId, activation!.owner_actor_id]
  );
  const tlThread = await db.query<{ id: string }>(
    `insert into public.comm_threads (business_id, created_by, contact_id, engagement_id, channel)
     values ($1, $2, $3, $4, 'email') returning id`,
    [activation!.business_id, activation!.light_actor_id, tlContact.rows[0]!.id, tlEngagement.rows[0]!.id]
  );
  const tlDraft = async (body: string) => {
    const r = await db.query<{ id: string }>(
      `insert into public.communications (business_id, created_by, thread_id, contact_id, engagement_id, channel, direction, status, body, drafted_by_actor_id)
       values ($1, $2, $3, $4, $5, 'email', 'outbound', 'draft', $6, $2) returning id`,
      [activation!.business_id, activation!.light_actor_id, tlThread.rows[0]!.id, tlContact.rows[0]!.id, tlEngagement.rows[0]!.id, body]
    );
    await db.query(`select public.submit_communication($1, $2)`, [r.rows[0]!.id, activation!.light_actor_id]);
    await recordCompliance(r.rows[0]!.id, activation!.light_actor_id);
    await db.query(`select public.approve_communication($1, $2)`, [r.rows[0]!.id, activation!.owner_actor_id]);
    return r.rows[0]!.id;
  };

  const tlStage = async () => {
    const r = await db.query<{ stage_id: string }>(
      `select stage_id from public.engagements where id = $1`,
      [tlEngagement.rows[0]!.id]
    );
    return r.rows[0]!.stage_id;
  };

  const tlComm1 = await tlDraft("Hello — thank you for your enquiry. Booking link inside.");
  await expectOk("a draft and a STAMP alone never move the stage (not draft, not stamp)", async () => {
    if ((await tlStage()) !== installedNewLeadId) throw new Error("the enquiry left New before any outbound was dispatched");
  });
  await expectOk("the first genuinely dispatched outbound moves New → Contacted through the gated pipeline", async () => {
    await db.query(`select public.mark_communication_sent($1, 'graph', '<transition-1@firm.example>')`, [tlComm1]);
    if ((await tlStage()) !== installedContactedId) throw new Error("the enquiry did not move to Contacted on first dispatch");
    const hist = await db.query<{ n: number }>(
      `select count(*)::int as n from public.stage_history where engagement_id = $1 and to_stage = $2`,
      [tlEngagement.rows[0]!.id, installedContactedId]
    );
    if (hist.rows[0]!.n !== 1) throw new Error(`stage_history rows to Contacted: ${hist.rows[0]!.n}`);
    const mover = await db.query<{ actor_type: string }>(
      `select a.actor_type from public.stage_history h join public.actors a on a.id = h.moved_by
       where h.engagement_id = $1 and h.to_stage = $2`,
      [tlEngagement.rows[0]!.id, installedContactedId]
    );
    if (mover.rows[0]!.actor_type !== "workflow") throw new Error(`the move attributes to ${mover.rows[0]!.actor_type}, not the workflow actor`);
  });
  await expectOk("a second dispatched outbound moves nothing — the law fires once", async () => {
    const tlComm2 = await tlDraft("A follow-up note.");
    await db.query(`select public.mark_communication_sent($1, 'graph', '<transition-2@firm.example>')`, [tlComm2]);
    if ((await tlStage()) !== installedContactedId) throw new Error("the stage moved again");
    const hist = await db.query<{ n: number }>(
      `select count(*)::int as n from public.stage_history where engagement_id = $1`,
      [tlEngagement.rows[0]!.id]
    );
    if (hist.rows[0]!.n !== 1) throw new Error(`stage_history rows: ${hist.rows[0]!.n} (expected the single Contacted move)`);
  });

  // --- nurture bands at compressed time (TIME_SCALE pinned above) ----------
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const noStamps: NurtureStamps = {
    reminder_24h_sent_at: null, reminder_3d_sent_at: null, reminder_7d_sent_at: null, nurture_unsubscribed_at: null,
  };
  await expectOk("nurture bands: 24h resume → day-3 story → day-7 founder's note → 30d delete (compressed clock)", async () => {
    const cases: [number, NurtureStamps, string | null][] = [
      [scaleDurationMs(25 * HOUR), noStamps, "24h"],
      [scaleDurationMs(25 * HOUR), { ...noStamps, reminder_24h_sent_at: "x" }, null],
      [scaleDurationMs(3 * DAY + HOUR), noStamps, "3d"],
      [scaleDurationMs(3 * DAY + HOUR), { ...noStamps, reminder_3d_sent_at: "x" }, null],
      [scaleDurationMs(8 * DAY), noStamps, "7d"],
      [scaleDurationMs(8 * DAY), { ...noStamps, reminder_7d_sent_at: "x" }, null],
      [scaleDurationMs(31 * DAY), noStamps, "delete"],
      [scaleDurationMs(HOUR), noStamps, null],
    ];
    for (const [age, stamps, want] of cases) {
      const got = dueNurtureStep(age, stamps);
      if (got !== want) throw new Error(`age ${age}ms with ${JSON.stringify(stamps)}: got ${got}, want ${want}`);
    }
  });
  await expectOk("an unsubscribed signup receives NO nurture mail — deletion at 30 days still runs", async () => {
    const unsub: NurtureStamps = { ...noStamps, nurture_unsubscribed_at: "x" };
    if (dueNurtureStep(scaleDurationMs(25 * HOUR), unsub) !== null) throw new Error("24h mailed an unsubscribed signup");
    if (dueNurtureStep(scaleDurationMs(4 * DAY), unsub) !== null) throw new Error("3d mailed an unsubscribed signup");
    if (dueNurtureStep(scaleDurationMs(8 * DAY), unsub) !== null) throw new Error("7d mailed an unsubscribed signup");
    if (dueNurtureStep(scaleDurationMs(31 * DAY), unsub) !== "delete") throw new Error("30d retention stopped applying");
  });

  // ---------------------------------------------------------------------
  // Session 13 fix round — decision 84's per-row law in the basics
  // evaluator (pure TS, the Meta-signature precedent): the founder's
  // unearned-tick repro is the refusal case, held forever.
  // ---------------------------------------------------------------------
  console.log("\nSession 13 — the basics per-row law:");

  const SIX = [...CANONICAL_BASICS_KEYS];
  await expectOk("the Jurists repro is refused: one confirmed row of six is NOT ready", async () => {
    const r = evaluateBasicsReadiness(SIX, {
      basics_confirmed: { business_name: { state: "confirmed" } },
    });
    if (r.ready) throw new Error("one addressed row earned the tick");
    if (r.missing.length !== 5) throw new Error(`missing: ${r.missing.join(", ")}`);
  });
  await expectOk("an EMPTY required set fails closed — stamps present, still never ready", async () => {
    const r = evaluateBasicsReadiness([], {
      basics_confirmed: { business_name: { state: "confirmed" } },
    });
    if (r.ready) throw new Error("an empty required set read as nothing-missing (the root cause)");
  });
  await expectOk("the required-set resolver never returns empty — no template means the canonical six", async () => {
    if (resolveBasicsRequiredKeys(undefined).length !== 6) throw new Error("undefined did not resolve to the canonical six");
    if (resolveBasicsRequiredKeys([]).length !== 6) throw new Error("[] did not resolve to the canonical six");
    const own = ["business_name", "address"];
    if (resolveBasicsRequiredKeys(own) !== own) throw new Error("an installed set was not honoured");
  });
  await expectOk("every row individually addressed — confirms and explicit not-applicables — IS ready, honestly split", async () => {
    const r = evaluateBasicsReadiness(SIX, {
      basics_confirmed: {
        business_name: { state: "confirmed" },
        regulated_status: { state: "confirmed" },
        address: {}, // a Session 11 stamp without `state` is a confirm
        business_hours: { state: "not_applicable" },
        languages: { state: "not_applicable" },
        quiet_hours: { state: "confirmed" },
      },
    });
    if (!r.ready) throw new Error(`not ready: missing ${r.missing.join(", ")}`);
    if (JSON.stringify(r.confirmedKeys) !== JSON.stringify(["business_name", "regulated_status", "address", "quiet_hours"])) {
      throw new Error(`confirmed split: ${r.confirmedKeys.join(", ")}`);
    }
    if (JSON.stringify(r.notApplicableKeys) !== JSON.stringify(["business_hours", "languages"])) {
      throw new Error(`not-applicable split: ${r.notApplicableKeys.join(", ")}`);
    }
  });

  // ---------------------------------------------------------------------
  // Chore (30 Jul 2026) — decision 119, WYSIWYS is per-channel: the drafter
  // renders the body of the channel the draft will dispatch on; the
  // WhatsApp entry is the approved template text verbatim.
  // ---------------------------------------------------------------------
  console.log("\nDecision 119 — per-channel template bodies:");

  const perChannelTemplate = {
    body: "The email copy.",
    attributes: { bodies: { whatsapp: "The approved WhatsApp wording." } },
  };
  await expectOk("the picked channel's body wins — a WhatsApp draft shows the approved wording", async () => {
    if (resolveTemplateBody(perChannelTemplate, "whatsapp") !== "The approved WhatsApp wording.") {
      throw new Error("whatsapp did not resolve to its own body");
    }
  });
  await expectOk("a channel without its own body keeps the default — email copy untouched", async () => {
    if (resolveTemplateBody(perChannelTemplate, "email") !== "The email copy.") {
      throw new Error("email did not fall back to the default body");
    }
    if (resolveTemplateBody({ body: "Only body.", attributes: {} }, "whatsapp") !== "Only body.") {
      throw new Error("a template without bodies did not fall back");
    }
  });
  await expectOk("a blank channel entry never blanks a draft — the default holds", async () => {
    const blank = { body: "Default.", attributes: { bodies: { whatsapp: "   " } } };
    if (resolveTemplateBody(blank, "whatsapp") !== "Default.") {
      throw new Error("a blank channel body blanked the draft");
    }
  });

  // ---------------------------------------------------------------------
  // 0023 — superseded template versions are read-only history (decision
  // 120): the fix that lands on the row nobody reads is now impossible,
  // not merely noticed.
  // ---------------------------------------------------------------------
  console.log("\n0023 — the superseded-template guard:");

  const guardRows = await db.query<{ id: string; version: number }>(
    `insert into public.message_templates (business_id, created_by, key, channel, subject, body, version)
     values ($1, $2, 'guard_t', 'email', 'One', 'Version one.', 1),
            ($1, $2, 'guard_t', 'email', 'Two', 'Version two.', 2)
     returning id, version`,
    [f.business_id, f.human_id]
  );
  const guardId = new Map(guardRows.rows.map((r) => [r.version, r.id]));

  await expectError(
    "a superseded version refuses the fix that lands on the row nobody reads",
    /superseded/,
    () =>
      db.query(`update public.message_templates set attributes = '{"wa_template":{"name":"late_fix"}}'::jsonb where id = $1`, [
        guardId.get(1),
      ])
  );
  await expectOk("the latest version accepts the same write", async () => {
    await db.query(`update public.message_templates set attributes = '{"wa_template":{"name":"on_latest"}}'::jsonb where id = $1`, [
      guardId.get(2),
    ]);
  });
  await expectOk("archiving a superseded version stays legal — history keeps its housekeeping", async () => {
    await db.query(`update public.message_templates set archived_at = now() where id = $1`, [guardId.get(1)]);
  });
  await expectOk("a version whose newer siblings are all archived is the effective latest again — updates lawful", async () => {
    await db.query(`update public.message_templates set archived_at = now() where id = $1`, [guardId.get(2)]);
    await db.query(`update public.message_templates set archived_at = null where id = $1`, [guardId.get(1)]);
    await db.query(`update public.message_templates set attributes = '{"back":"in service"}'::jsonb where id = $1`, [
      guardId.get(1),
    ]);
  });

  // ---------------------------------------------------------------------
  // Session 15 — the drafting engine's pure layer: form answers, route
  // matching, task-scoped selection, routing floors + earned escalation,
  // and per-channel composition against an injected fake provider.
  // ---------------------------------------------------------------------
  console.log("\nSession 15 — the drafting engine (pure layer):");

  await expectOk("Meta field data becomes ordered form answers, names verbatim (PR-2)", async () => {
    const answers = formAnswersFromFieldData([
      { name: "full_name", values: ["Ayesha Khan"] },
      { name: "what_visa_are_you_interested_in?", values: ["Skilled Worker"] },
      { name: "tell_us_about_your_situation", values: ["My employer will sponsor me", "Start date in March"] },
    ]);
    if (answers.length !== 3) throw new Error(`expected 3 answers, got ${answers.length}`);
    if (answers[1]!.name !== "what_visa_are_you_interested_in?") throw new Error("field name was not preserved verbatim");
    if (answers[1]!.label !== "What visa are you interested in?") throw new Error(`label: ${answers[1]!.label}`);
    if (answers[2]!.value !== "My employer will sponsor me, Start date in March") throw new Error("multi-value answer not joined");
  });

  await expectOk("route matching reads the lead's own words — a lookup, never an inference", async () => {
    if (JSON.stringify(matchRoutes("My employer will sponsor me for a Skilled Worker visa")) !== '["skilled_worker"]') {
      throw new Error("skilled worker did not match");
    }
    const multi = matchRoutes("I am on a spouse visa and want ILR next year");
    if (!multi.includes("spouse_family") || !multi.includes("ilr")) throw new Error(`multi-route: ${multi.join(",")}`);
    if (matchRoutes("Hello, I would like some help").length !== 0) throw new Error("matched a route from nothing");
  });

  await expectOk("task-scoped selection keys on the RESOLVED route (D179c), fees never enter the pack (D179a), capped — never the whole pack", async () => {
    const pack: KnowledgeEntry[] = [
      { id: "sw", title: "Skilled Worker", category: "service_description", visa_route: "skilled_worker", text: "SW route." },
      { id: "sp", title: "Spouse", category: "service_description", visa_route: "spouse_family", text: "Spouse route." },
      { id: "fees", title: "Fees", category: "published_fees", visa_route: null, text: "Consultation £150." },
      { id: "book", title: "Booking", category: "consultation_booking_policy", visa_route: null, text: "Book online." },
      { id: "tone1", title: "Tone", category: "tone_exemplar", visa_route: null, text: "Warm, plain." },
      { id: "faq1", title: "Financial requirement", category: "faq", visa_route: null, text: "About the financial requirement." },
      { id: "faq2", title: "Sponsorship evidence", category: "faq", visa_route: null, text: "About sponsorship and employer evidence." },
    ];
    const result = selectKnowledgeEntries(pack, "My employer offered sponsorship for a skilled worker role", "skilled_worker");
    const ids = result.entries.map((e) => e.id);
    if (!ids.includes("sw")) throw new Error("the resolved route's service description missing");
    if (ids.includes("sp")) throw new Error("the OTHER route's service description was dumped in");
    if (ids.includes("fees")) throw new Error("published_fees entered the pack — the model must never see a fee (D179a)");
    if (!ids.includes("book")) throw new Error("booking policy missing");
    if (!ids.includes("faq2")) throw new Error("word-relevant FAQ missing");
    if (result.entries.length > DRAFT_CONTEXT_BUDGETS.max_pack_entries) throw new Error("selection exceeded the pack cap");
    // D179c: the resolved route KEYS the selection — the same ILR-worded
    // text with route resolved elsewhere selects that route's entry, and a
    // null resolution keeps the pack route-neutral (no wrong-route copy).
    const crossIds = selectKnowledgeEntries(pack, "I want ILR next year", "spouse_family").entries.map((e) => e.id);
    if (!crossIds.includes("sp") || crossIds.includes("sw")) {
      throw new Error("selection followed the text, not the resolved route");
    }
    const neutralIds = selectKnowledgeEntries(pack, "I want ILR and my spouse to join me", null).entries.map((e) => e.id);
    if (neutralIds.includes("sw") || neutralIds.includes("sp")) {
      throw new Error("an unresolved route still pulled route-specific copy — the draft must stay route-neutral");
    }
  });

  await expectOk("routing: floor by default; escalation EARNED by recorded trigger (doctrine)", async () => {
    const calm = resolveEscalation({ leadText: "I would like help with my application", routeMatches: 1, contextTokens: 500 });
    if (calm.tier !== "standard" || calm.model !== LIGHT_MODEL_FLOOR.model || calm.reason !== "floor") {
      throw new Error(`calm lead did not route to the floor: ${JSON.stringify(calm)}`);
    }
    const nogo = resolveEscalation({ leadText: "Can you guarantee my visa?", routeMatches: 1, contextTokens: 500 });
    if (nogo.tier !== "pro" || nogo.model !== LIGHT_MODEL_ESCALATION.model || !/no-go/.test(nogo.reason)) {
      throw new Error(`no-go proximity did not escalate: ${JSON.stringify(nogo)}`);
    }
    const multi = resolveEscalation({ leadText: "hello", routeMatches: 2, contextTokens: 500 });
    if (multi.tier !== "pro" || !/multi-route/.test(multi.reason)) throw new Error("multi-route did not escalate");
    const big = resolveEscalation({ leadText: "hello", routeMatches: 1, contextTokens: DRAFT_CONTEXT_BUDGETS.floor_tokens + 1 });
    if (big.tier !== "pro" || !/budget/.test(big.reason)) throw new Error("over-floor context did not escalate");
  });

  await expectOk("per-channel from birth: an email draft is COMPOSED against the lead's words, credit line priced", async () => {
    let sawPrompt = "";
    const fake: GenerateFn = async (request) => {
      sawPrompt = `${request.system}\n${request.prompt}`;
      return {
        subject: "Your enquiry with Test Firm",
        body: "Hello Ayesha,\n\nThank you for your enquiry about the Skilled Worker route...",
        attestation: { attested: true, statement: "Complies with every rule." },
        usage: { input_tokens: 900, output_tokens: 120 },
      };
    };
    const answers = [{ name: "situation", label: "Situation", value: "Employer sponsorship for skilled worker" }];
    const result = await composeDraft(fake, {
      business_name: "Test Firm",
      sign_off: "Test Firm",
      first_name: "Ayesha",
      full_name: "Ayesha Khan",
      channel: "email",
      task: "intro",
      enquiry_title: "Ayesha Khan — enquiry",
      stage_label: "New",
      source: "meta",
      form_answers: answers,
      no_go_rules: ["Light never states or implies a guarantee of visa success."],
      retrieval: {
        entries: [{ id: "sw", title: "Skilled Worker", category: "service_description", visa_route: "skilled_worker", text: "SW route facts." }],
        route_matches: ["skilled_worker"],
      },
    });
    if (!/Employer sponsorship/.test(sawPrompt)) throw new Error("the lead's own words were not in the prompt");
    if (!/never states or implies a guarantee/.test(sawPrompt)) throw new Error("the no-go rules were not IN the generation prompt");
    if (!/SW route facts/.test(sawPrompt)) throw new Error("the selected pack entry was not assembled");
    // Founder-ruled at close review: the sign-off is the FIRM's identity
    // value, never a personal name.
    if (!/Sign off as "Test Firm"/.test(sawPrompt)) throw new Error("the firm sign-off was not instructed");
    if (/Mudassir/.test(sawPrompt)) throw new Error("a personal name leaked into the sign-off instruction");
    if (result.credit_line.tier !== "standard" || result.credit_line.reason !== "floor") {
      throw new Error(`credit line: ${JSON.stringify(result.credit_line)}`);
    }
    if (JSON.stringify(result.credit_line.knowledge_entry_ids) !== '["sw"]') throw new Error("pack entry ids not recorded");
    if (result.attestation.mode !== "generated" || !result.attestation.attested) throw new Error("attestation not captured");
  });

  await expectOk("a generated body with unresolved braces is a PERMANENT visible failure — never submitted", async () => {
    const fake: GenerateFn = async () => ({
      subject: null,
      body: "Hello {{first_name}}, this should never pass",
      attestation: { attested: true, statement: "x" },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    let threw = false;
    try {
      await composeDraft(fake, {
        business_name: "T", sign_off: "T", first_name: "A", full_name: "A B", channel: "email",
        task: "intro", enquiry_title: "t", stage_label: "New", source: "meta",
        form_answers: [], no_go_rules: [], retrieval: { entries: [], route_matches: [] },
      });
    } catch (err) {
      threw = err instanceof PermanentGenerationError;
    }
    if (!threw) throw new Error("braces survived composition");
  });

  await expectOk("over-budget assembly fails VISIBLY — never a trim-and-hope", async () => {
    const fake: GenerateFn = async () => {
      throw new Error("the provider must never be called on an over-budget assembly");
    };
    const huge = "x".repeat((DRAFT_CONTEXT_BUDGETS.escalation_tokens + 100) * 4);
    let threw = false;
    try {
      await composeDraft(fake, {
        business_name: "T", sign_off: "T", first_name: "A", full_name: "A B", channel: "email",
        task: "intro", enquiry_title: "t", stage_label: "New", source: "meta",
        form_answers: [{ name: "s", label: "S", value: "calm" }], no_go_rules: [],
        retrieval: { entries: [{ id: "big", title: "Big", category: "faq", visa_route: null, text: huge }], route_matches: [] },
      });
    } catch (err) {
      threw = err instanceof PermanentGenerationError && /over-budget/.test((err as Error).message);
    }
    if (!threw) throw new Error("over-budget assembly did not fail visibly");
  });

  await expectOk("leadTextFromAnswers flattens what the lead SAID for triggers and retrieval", async () => {
    const text = leadTextFromAnswers([
      { name: "q1", label: "Visa type", value: "Skilled Worker" },
      { name: "q2", label: "Question", value: "How much does it cost?" },
    ]);
    if (!/Visa type: Skilled Worker/.test(text) || !/How much does it cost/.test(text)) {
      throw new Error(`flattened text: ${text}`);
    }
  });

  // ---------------------------------------------------------------------
  // Session 15 — the compliance pre-flight (0026, ruling C-2) and
  // draft_feedback (0025, PR-4). Refusal-first: the forbidden thing is
  // attempted and the database throws.
  // ---------------------------------------------------------------------
  console.log("\nSession 15 — compliance pre-flight and draft_feedback:");

  // All on the ACTIVATED tenant: a real v3 install with the four no-go
  // rules on its templates row and businesses.template_id set.
  const s15Contact = await db.query<{ id: string }>(
    `insert into public.contacts (business_id, created_by, type, display_name)
     values ($1, $2, 'person', 'Compliance Lead') returning id`,
    [activation!.business_id, activation!.light_actor_id]
  );
  await db.query(
    `insert into public.contact_channels (business_id, created_by, contact_id, channel, value, is_primary, consent)
     values ($1, $2, $3, 'email', 'compliance@lead.test', true, '{"transactional": true}'::jsonb)`,
    [activation!.business_id, activation!.light_actor_id, s15Contact.rows[0]!.id]
  );
  const s15Thread = await db.query<{ id: string }>(
    `insert into public.comm_threads (business_id, created_by, contact_id, channel)
     values ($1, $2, $3, 'email') returning id`,
    [activation!.business_id, activation!.light_actor_id, s15Contact.rows[0]!.id]
  );
  // Session 16: one pending outbound per thread+channel is now law (0030) —
  // each compliance test draft takes its own thread so unresolved pendings
  // from refusal tests cannot collide with later submissions.
  const s15Draft = async (body: string) => {
    const t = await db.query<{ id: string }>(
      `insert into public.comm_threads (business_id, created_by, contact_id, channel)
       values ($1, $2, $3, 'email') returning id`,
      [activation!.business_id, activation!.light_actor_id, s15Contact.rows[0]!.id]
    );
    const r = await db.query<{ id: string }>(
      `insert into public.communications (business_id, created_by, thread_id, contact_id, channel, direction, status, body, drafted_by_actor_id)
       values ($1, $2, $3, $4, 'email', 'outbound', 'draft', $5, $2) returning id`,
      [activation!.business_id, activation!.light_actor_id, t.rows[0]!.id, s15Contact.rows[0]!.id, body]
    );
    await db.query(`select public.submit_communication($1, $2)`, [r.rows[0]!.id, activation!.light_actor_id]);
    return r.rows[0]!.id;
  };
  const s15Check = async (commId: string, attested = true) => {
    const r = await db.query<{ out: { result: string; rule_matched: string | null; attested: boolean } }>(
      `select public.run_compliance_check($1, $2, $3::jsonb) as out`,
      [commId, activation!.light_actor_id, attested ? TEST_ATTESTATION : null]
    );
    return r.rows[0]!.out;
  };

  await expectOk("an agent draft is born compliance-required; a human draft is not (C-2: the gate binds the machine)", async () => {
    const a = await db.query<{ id: string; required: boolean }>(
      `insert into public.communications (business_id, created_by, thread_id, channel, direction, status, body, drafted_by_actor_id)
       values ($1, $2, $3, 'email', 'outbound', 'draft', 'agent words', $2) returning id, compliance_required as required`,
      [activation!.business_id, activation!.light_actor_id, s15Thread.rows[0]!.id]
    );
    const h = await db.query<{ id: string; required: boolean }>(
      `insert into public.communications (business_id, created_by, thread_id, channel, direction, status, body)
       values ($1, $2, $3, 'email', 'outbound', 'draft', 'human words') returning id, compliance_required as required`,
      [activation!.business_id, activation!.owner_actor_id, s15Thread.rows[0]!.id]
    );
    if (!a.rows[0]!.required) throw new Error("an agent draft was born exempt");
    if (h.rows[0]!.required) throw new Error("a human draft was born bound — decision-21 behaviour changed");
  });

  await expectOk("compliance_required is immutable after birth, whatever code writes", async () => {
    const a = await db.query<{ id: string }>(
      `insert into public.communications (business_id, created_by, thread_id, channel, direction, status, body, drafted_by_actor_id)
       values ($1, $2, $3, 'email', 'outbound', 'draft', 'immutable stamp', $2) returning id`,
      [activation!.business_id, activation!.light_actor_id, s15Thread.rows[0]!.id]
    );
    await db.query(`update public.communications set compliance_required = false where id = $1`, [a.rows[0]!.id]);
    const after = await db.query<{ required: boolean }>(
      `select compliance_required as required from public.communications where id = $1`,
      [a.rows[0]!.id]
    );
    if (!after.rows[0]!.required) throw new Error("the requiredness stamp was overwritten");
  });

  await expectError(
    "fail closed: an unrun compliance check blocks the stamp — pending, never green",
    /has not run/,
    async () => {
      const id = await s15Draft("Thank you for your enquiry — happy to help.");
      await db.query(`select public.approve_communication($1, $2)`, [id, activation!.owner_actor_id]);
    }
  );

  await expectOk("the DoD provocation reads CLEAN: declining to guarantee is the lawful wording", async () => {
    const id = await s15Draft(
      "We cannot guarantee any visa outcome — no honest adviser can — but we can assess your situation properly in a consultation."
    );
    const out = await s15Check(id);
    if (out.result !== "clean") throw new Error(`the refusal wording read as ${out.result}: ${out.rule_matched}`);
    await db.query(`select public.approve_communication($1, $2)`, [id, activation!.owner_actor_id]);
  });

  await expectError(
    "guarantee language breaches rule 1 and the stamp is REFUSED with the rule named",
    /No-go rule breached: Light never states or implies a guarantee/,
    async () => {
      const id = await s15Draft("Good news — we guarantee your visa will be approved.");
      const out = await s15Check(id);
      if (out.result !== "breach") throw new Error("guarantee language read as clean");
      await db.query(`select public.approve_communication($1, $2)`, [id, activation!.owner_actor_id]);
    }
  );

  await expectOk("fee amounts the firm has published read clean; unpublished amounts breach rule 3", async () => {
    await db.query(
      `insert into public.content_items (business_id, created_by, content_type, title, slug, body, state, published_by_actor_id, published_at, attributes)
       values ($1, $2, 'knowledge_entry', 'Published fees', 'published-fees',
               '[{"type":"paragraph","text":"Initial consultation: £150, credited against instruction."}]'::jsonb,
               'published', $3, now(), '{"knowledge_category":"published_fees"}'::jsonb)`,
      [activation!.business_id, activation!.owner_actor_id, activation!.owner_actor_id]
    );
    const cleanId = await s15Draft("Our consultation is £150, credited if you instruct us.");
    const clean = await s15Check(cleanId);
    if (clean.result !== "clean") throw new Error(`published fee read as ${clean.result}: ${clean.rule_matched}`);
    const breachId = await s15Draft("For the full application our fee is £2,500.");
    const breach = await s15Check(breachId);
    if (breach.result !== "breach") throw new Error("an unpublished fee read as clean");
    if (!/published consultation fee/.test(breach.rule_matched ?? "")) {
      throw new Error(`rule named: ${breach.rule_matched}`);
    }
  });

  await expectError(
    "heuristics alone never earn the tick — a clean check without attestation still blocks",
    /attestation/,
    async () => {
      const id = await s15Draft("A perfectly clean body with no attestation recorded.");
      const out = await s15Check(id, false);
      if (out.result !== "clean") throw new Error("fixture body was not clean");
      await db.query(`select public.approve_communication($1, $2)`, [id, activation!.owner_actor_id]);
    }
  );

  await expectError(
    "a signed-in session cannot RUN a compliance check (the runner is server-only)",
    /permission denied/,
    async () => {
      const id = await s15Draft("Forgery attempt one.");
      await db.exec(`set role authenticated`);
      await db.exec(`set request.jwt.claim.sub = '${ids.user}'`);
      try {
        await db.query(`select public.run_compliance_check($1, $2, null)`, [id, f.human_id]);
      } finally {
        await db.exec(`reset role`);
        await db.exec(`set request.jwt.claim.sub = ''`);
      }
    }
  );

  await expectError(
    "a signed-in session cannot FORGE a check row (no authenticated insert door exists)",
    /row-level security|permission denied/,
    async () => {
      const id = await s15Draft("Forgery attempt two.");
      await db.exec(`set role authenticated`);
      await db.exec(`set request.jwt.claim.sub = '${ids.user}'`);
      try {
        await db.query(
          `insert into public.communication_compliance_checks
             (business_id, created_by, communication_id, body, result, heuristics, attestation)
           values ($1, $2, $3, 'Forgery attempt two.', 'clean', '{}'::jsonb, '{"attested":true}'::jsonb)`,
          [activation!.business_id, f.human_id, id]
        );
      } finally {
        await db.exec(`reset role`);
        await db.exec(`set request.jwt.claim.sub = ''`);
      }
    }
  );

  await expectOk("a recorded check is append-only history", async () => {
    const id = await s15Draft("A body whose check becomes history.");
    await s15Check(id);
    let threw = false;
    try {
      await db.query(`update public.communication_compliance_checks set result = 'clean' where communication_id = $1`, [id]);
    } catch (err) {
      threw = /append-only/.test(err instanceof Error ? err.message : String(err));
    }
    if (!threw) throw new Error("a check row accepted an update");
  });

  // --- draft_feedback (0025, PR-4) ----------------------------------------
  let feedbackId = "";
  let feedbackCommId = "";
  await expectOk("an edit and a rejection land as draft_feedback rows, template-queryable", async () => {
    const commId = await s15Draft("Feedback fixture body.");
    feedbackCommId = commId;
    const tpl = await db.query<{ template_id: string }>(
      `select template_id from public.businesses where id = $1`,
      [activation!.business_id]
    );
    const r = await db.query<{ id: string }>(
      `insert into public.draft_feedback
         (business_id, created_by, communication_id, template_id, kind, body_before, body_after, reason, pack_entry_ids)
       values ($1, $2, $3, $4, 'edit', 'Feedback fixture body.', 'Feedback fixture body, tightened.', 'Too long.', '["00000000-0000-4000-8000-00000000aaaa"]'::jsonb)
       returning id`,
      [activation!.business_id, activation!.owner_actor_id, commId, tpl.rows[0]!.template_id]
    );
    feedbackId = r.rows[0]!.id;
    await db.query(
      `insert into public.draft_feedback
         (business_id, created_by, communication_id, template_id, kind, body_before, reason)
       values ($1, $2, $3, $4, 'rejection', 'Feedback fixture body.', 'Shadow mode — handled by existing pipeline')`,
      [activation!.business_id, activation!.owner_actor_id, commId, tpl.rows[0]!.template_id]
    );
    const n = await db.query<{ n: number }>(
      `select count(*)::int as n from public.draft_feedback where template_id = $1`,
      [tpl.rows[0]!.template_id]
    );
    if (n.rows[0]!.n !== 2) throw new Error(`template query found ${n.rows[0]!.n} rows`);
  });

  await expectError("draft_feedback is append-only — the signal cannot be rewritten", /append-only/, () =>
    db.query(`update public.draft_feedback set reason = 'revised history' where id = $1`, [feedbackId])
  );
  await expectError("draft_feedback cannot be deleted", /append-only/, () =>
    db.query(`delete from public.draft_feedback where id = $1`, [feedbackId])
  );
  await expectError(
    "a rejection row must carry its reason and no after-body (the 0017 reason law, mirrored)",
    /draft_feedback_shape/,
    () =>
      db.query(
        `insert into public.draft_feedback
           (business_id, created_by, communication_id, kind, body_before, body_after)
         values ($1, $2, $3, 'rejection', 'before', 'after')`,
        [activation!.business_id, activation!.owner_actor_id, feedbackCommId]
      )
  );

  // --- 0027: the waiting clock is the client's, immutable across edits ----
  await expectOk("the waiting clock is the CLIENT's — an edit never resets awaiting_since (0027)", async () => {
    const id = await s15Draft("The waiting clock belongs to the client, not the editor.");
    await s15Check(id);
    const before = await db.query<{ awaiting_since: string; submitted_at: string }>(
      `select v.awaiting_since::text as awaiting_since, c.submitted_at::text as submitted_at
       from public.approval_inbox v join public.communications c on c.id = v.item_id
       where v.item_id = $1`,
      [id]
    );
    if (!before.rows[0]) throw new Error("the submitted draft is not in the inbox");
    if (before.rows[0].submitted_at === null) throw new Error("submitted_at was not stamped at the pending transition");
    if (before.rows[0].awaiting_since !== before.rows[0].submitted_at) {
      throw new Error("awaiting_since is not keyed to the submission stamp");
    }
    // The edit: words change, the age must not — and even an explicit write
    // to the clock is forced back by the trigger, whatever code carries it.
    await db.query(
      `update public.communications set body = body || ' (edited)', submitted_at = '2020-01-01T00:00:00Z' where id = $1`,
      [id]
    );
    const after = await db.query<{ awaiting_since: string; submitted_at: string }>(
      `select v.awaiting_since::text as awaiting_since, c.submitted_at::text as submitted_at
       from public.approval_inbox v join public.communications c on c.id = v.item_id
       where v.item_id = $1`,
      [id]
    );
    if (after.rows[0]!.submitted_at !== before.rows[0].submitted_at) {
      throw new Error("an edit (or an explicit write) moved the submission stamp");
    }
    if (after.rows[0]!.awaiting_since !== before.rows[0].awaiting_since) {
      throw new Error("an edit reset the client's waiting clock — the inbox would lie about the lead's age");
    }
  });

  await expectError(
    "submitted_at is closed to direct update for API roles (the clock is not theirs to touch)",
    /permission denied/,
    async () => {
      await db.exec(`set role authenticated`);
      await db.exec(`set request.jwt.claim.sub = '${ids.user}'`);
      try {
        await db.query(`update public.communications set submitted_at = now() where id = $1`, [feedbackCommId]);
      } finally {
        await db.exec(`reset role`);
        await db.exec(`set request.jwt.claim.sub = ''`);
      }
    }
  );

  await expectOk("a re-submission after rejection lawfully restarts the wait (that queue period is new)", async () => {
    const id = await s15Draft("Rejected, revised, resubmitted.");
    await s15Check(id);
    const first = await db.query<{ submitted_at: string }>(
      `select submitted_at::text as submitted_at from public.communications where id = $1`,
      [id]
    );
    await db.query(`select public.reject_communication($1, $2, $3)`, [id, activation!.owner_actor_id, "Not yet."]);
    await db.query(`select pg_sleep(0.01)`);
    await db.query(`select public.submit_communication($1, $2)`, [id, activation!.light_actor_id]);
    const second = await db.query<{ submitted_at: string }>(
      `select submitted_at::text as submitted_at from public.communications where id = $1`,
      [id]
    );
    if (second.rows[0]!.submitted_at === first.rows[0]!.submitted_at) {
      throw new Error("a genuine re-submission did not restart the clock");
    }
  });

  // ---------------------------------------------------------------------
  // Session 16 — inbound capture (0028) and the supersede engine
  // (0029/0030). Refusal-first: the guard, the terminal state and the
  // service-only pipeline are all attempted from the wrong side.
  // ---------------------------------------------------------------------
  console.log("\nSession 16 — inbound capture and the supersede engine:");

  const s16Contact = await db.query<{ id: string }>(
    `insert into public.contacts (business_id, created_by, type, display_name)
     values ($1, $2, 'person', 'Supersede Lead') returning id`,
    [f.business_id, f.agent_id]
  );
  const s16ContactId = s16Contact.rows[0]!.id;
  await db.query(
    `insert into public.contact_channels (business_id, created_by, contact_id, channel, value, is_primary, consent)
     values ($1, $2, $3, 'email', 'supersede.lead@example.test', true, '{"transactional": true}'::jsonb)`,
    [f.business_id, f.agent_id, s16ContactId]
  );
  await db.query(
    `insert into public.contact_channels (business_id, created_by, contact_id, channel, value, is_primary, consent)
     values ($1, $2, $3, 'whatsapp', '+447700900456', true, '{"transactional": true}'::jsonb)`,
    [f.business_id, f.agent_id, s16ContactId]
  );
  const s16Engagement = await db.query<{ id: string }>(
    `insert into public.engagements (business_id, created_by, template_type_id, title, stage_id, owner_actor_id)
     values ($1, $2, $3, 'Supersede enquiry', $4, $5) returning id`,
    [f.business_id, f.agent_id, f.type_id, f.stage_id, f.human_id]
  );
  const s16EngagementId = s16Engagement.rows[0]!.id;
  const s16NewThread = async (channel: string, withEngagement = true) => {
    const r = await db.query<{ id: string }>(
      `insert into public.comm_threads (business_id, created_by, contact_id, engagement_id, channel)
       values ($1, $2, $3, $4, '${channel}') returning id`,
      [f.business_id, f.agent_id, s16ContactId, withEngagement ? s16EngagementId : null]
    );
    return r.rows[0]!.id;
  };
  const s16NewDraft = async (threadId: string, channel: string, body: string) => {
    const r = await db.query<{ id: string }>(
      `insert into public.communications (business_id, created_by, thread_id, contact_id, engagement_id, channel, direction, status, body, drafted_by_actor_id)
       select $1, $2, $3, $4, t.engagement_id, '${channel}', 'outbound', 'draft', $5, $2
       from public.comm_threads t where t.id = $3 returning id`,
      [f.business_id, f.agent_id, threadId, s16ContactId, body]
    );
    return r.rows[0]!.id;
  };

  // --- 0028: the inbound claim tables are service-side only ---------------
  await expectOk("inbound claim tables: idempotent on the provider id; invisible and closed to signed-in sessions", async () => {
    await db.query(
      `insert into public.wa_webhook_events (wamid, phone_number_id, payload) values ('wamid.s16-1', '111', '{}'::jsonb)`
    );
    let threw = false;
    try {
      await db.query(`insert into public.wa_webhook_events (wamid) values ('wamid.s16-1')`);
    } catch (err) {
      threw = /duplicate key/.test(err instanceof Error ? err.message : String(err));
    }
    if (!threw) throw new Error("a replayed wamid claimed twice");
    await db.query(
      `insert into public.graph_mail_events (internet_message_id, mailbox) values ('<s16@example.test>', 'firm@example.test')`
    );
    await db.exec(`set role authenticated`);
    await db.exec(`set request.jwt.claim.sub = '${ids.user}'`);
    try {
      const wa = await db.query<{ n: number }>(`select count(*)::int as n from public.wa_webhook_events`);
      const gm = await db.query<{ n: number }>(`select count(*)::int as n from public.graph_mail_events`);
      if (wa.rows[0]!.n !== 0 || gm.rows[0]!.n !== 0) {
        throw new Error("a signed-in session can read raw provider payloads");
      }
      let insertRefused = false;
      try {
        await db.query(`insert into public.wa_webhook_events (wamid) values ('wamid.forged')`);
      } catch (err) {
        insertRefused = /row-level security|permission denied/.test(err instanceof Error ? err.message : String(err));
      }
      if (!insertRefused) throw new Error("a signed-in session wrote a claim row");
    } finally {
      await db.exec(`reset role`);
      await db.exec(`set request.jwt.claim.sub = ''`);
    }
  });

  // --- 0030: the one-pending guard ----------------------------------------
  let s16FirstPendingId = "";
  await expectError(
    "one pending outbound draft per engagement per channel — the second submission is refused by the DATABASE",
    /one_pending_per_engagement_channel/,
    async () => {
      const t1 = await s16NewThread("email");
      s16FirstPendingId = await s16NewDraft(t1, "email", "First answer, still awaiting the stamp.");
      await db.query(`select public.submit_communication($1, $2)`, [s16FirstPendingId, f.agent_id]);
      const t2 = await s16NewThread("email");
      const second = await s16NewDraft(t2, "email", "A second pending answer must not exist.");
      await db.query(`select public.submit_communication($1, $2)`, [second, f.agent_id]);
    }
  );

  await expectOk("the guard is per CHANNEL — a WhatsApp draft may pend beside the email draft", async () => {
    const t = await s16NewThread("whatsapp");
    const id = await s16NewDraft(t, "whatsapp", "Channel-parallel pending is lawful.");
    await db.query(`select public.submit_communication($1, $2)`, [id, f.agent_id]);
    // Retire it through the pipeline so later smokes start clean.
    await db.query(`select public.supersede_communication($1, 'new_inbound')`, [id]);
  });

  await expectOk("engagement-less threads carry the same guard, keyed by thread", async () => {
    const t = await s16NewThread("email", false);
    const a = await s16NewDraft(t, "email", "Pre-qualification draft one.");
    await db.query(`select public.submit_communication($1, $2)`, [a, f.agent_id]);
    const b = await s16NewDraft(t, "email", "Pre-qualification draft two.");
    let threw = false;
    try {
      await db.query(`select public.submit_communication($1, $2)`, [b, f.agent_id]);
    } catch (err) {
      threw = /one_pending_per_thread_channel/.test(err instanceof Error ? err.message : String(err));
    }
    if (!threw) throw new Error("a second engagement-less pending was admitted");
    await db.query(`select public.supersede_communication($1, 'new_inbound')`, [a]);
  });

  // --- 0030: supersede inherits the client's clock (decision 134) ---------
  await expectOk("a superseding draft INHERITS the original submitted_at — the client's wait never resets", async () => {
    const oldClock = await db.query<{ submitted_at: string }>(
      `select submitted_at::text as submitted_at from public.communications where id = $1`,
      [s16FirstPendingId]
    );
    if (!oldClock.rows[0]!.submitted_at) throw new Error("fixture draft has no submission stamp");
    await db.query(`select pg_sleep(0.01)`);
    const t = await s16NewThread("email");
    const successor = await s16NewDraft(t, "email", "Regenerated against the full thread — both messages answered.");
    await db.query(`select public.supersede_communication($1, 'new_inbound', $2, $3)`, [
      s16FirstPendingId,
      successor,
      f.agent_id,
    ]);
    const after = await db.query<{ old_status: string; succ_status: string; succ_clock: string; reason: string; successor_id: string }>(
      `select o.status::text as old_status, s.status::text as succ_status,
              s.submitted_at::text as succ_clock,
              o.attributes -> 'superseded' ->> 'reason' as reason,
              o.attributes -> 'superseded' ->> 'successor_id' as successor_id
       from public.communications o, public.communications s
       where o.id = $1 and s.id = $2`,
      [s16FirstPendingId, successor]
    );
    const r = after.rows[0]!;
    if (r.old_status !== "superseded") throw new Error(`old draft is ${r.old_status}`);
    if (r.succ_status !== "pending_approval") throw new Error(`successor is ${r.succ_status}`);
    if (r.succ_clock !== oldClock.rows[0]!.submitted_at) {
      throw new Error(`the clock reset: ${r.succ_clock} vs original ${oldClock.rows[0]!.submitted_at}`);
    }
    if (r.reason !== "new_inbound" || r.successor_id !== successor) {
      throw new Error("the superseded marker does not name its reason and successor");
    }
    const inbox = await db.query<{ awaiting_since: string }>(
      `select awaiting_since::text as awaiting_since from public.approval_inbox where item_id = $1`,
      [successor]
    );
    if (inbox.rows[0]!.awaiting_since !== oldClock.rows[0]!.submitted_at) {
      throw new Error("the inbox queue position did not follow the inherited clock");
    }
  });

  await expectError(
    "supersede is a service pipeline — a signed-in session cannot call it",
    /permission denied/,
    async () => {
      await db.exec(`set role authenticated`);
      await db.exec(`set request.jwt.claim.sub = '${ids.user}'`);
      try {
        await db.query(`select public.supersede_communication($1, 'new_inbound')`, [s16FirstPendingId]);
      } finally {
        await db.exec(`reset role`);
        await db.exec(`set request.jwt.claim.sub = ''`);
      }
    }
  );

  // --- 0030: a human reply auto-supersedes, in the same transaction -------
  let s16SupersededId = "";
  await expectOk("a HUMAN outbound on the thread auto-supersedes the pending draft (reason human_replied, no orphan)", async () => {
    const t = await s16NewThread("whatsapp");
    s16SupersededId = await s16NewDraft(t, "whatsapp", "Light's answer, awaiting the stamp.");
    await db.query(`select public.submit_communication($1, $2)`, [s16SupersededId, f.agent_id]);
    // The human replies from Conversations: decision-21 insert-at-approved.
    // (WhatsApp free-form passes pre-flight — the fixture holds no recent
    // inbound, so ride the approved-template path like a real manual send.)
    await db.query(
      `insert into public.communications (business_id, created_by, thread_id, contact_id, engagement_id, channel, direction, status, body, approved_by_actor_id, attributes)
       values ($1, $2, $3, $4, $5, 'whatsapp', 'outbound', 'approved', 'Human answer, sent directly.', $2,
               '{"wa_template": {"name": "enquiry_nudge", "language": "en_GB"}}'::jsonb)`,
      [f.business_id, f.human_id, t, s16ContactId, s16EngagementId]
    );
    const after = await db.query<{ status: string; reason: string; needs_event: string }>(
      `select status::text as status,
              attributes -> 'superseded' ->> 'reason' as reason,
              attributes -> 'superseded' ->> 'needs_event' as needs_event
       from public.communications where id = $1`,
      [s16SupersededId]
    );
    const r = after.rows[0]!;
    if (r.status !== "superseded") throw new Error(`the pending draft is ${r.status} — an orphan survived the human`);
    if (r.reason !== "human_replied") throw new Error(`reason recorded as ${r.reason}`);
    if (r.needs_event !== "true") throw new Error("the transition left no event marker for The Record");
  });

  // --- 0030: superseded is terminal, frozen, never deletable --------------
  await expectError("superseded is TERMINAL — status never leaves it", /terminal/, () =>
    db.query(`update public.communications set status = 'draft' where id = $1`, [s16SupersededId])
  );
  await expectError("a superseded draft is FROZEN history — its words never change", /frozen history/, () =>
    db.query(`update public.communications set body = 'rewritten history' where id = $1`, [s16SupersededId])
  );
  await expectError("superseded rows are NEVER deleted — History keeps its record", /never deleted/, () =>
    db.query(`delete from public.communications where id = $1`, [s16SupersededId])
  );
  await expectError("a communication cannot be BORN superseded", /born superseded/, async () => {
    const t = await s16NewThread("email");
    await db.query(
      `insert into public.communications (business_id, created_by, thread_id, channel, direction, status, body)
       values ($1, $2, $3, 'email', 'outbound', 'superseded', 'never lived')`,
      [f.business_id, f.agent_id, t]
    );
  });

  // --- PR-C: the settle window (pure policy, timeScale-proven) ------------
  await expectOk("settle options resolve instant/1/3/5 with default 3; unlawful values fall to the default", async () => {
    if (resolveSettleMinutes({}) !== SETTLE_WINDOW_DEFAULT_MINUTES) throw new Error("absent ≠ default");
    if (resolveSettleMinutes({ draft_settle_minutes: 0 }) !== 0) throw new Error("instant not honoured");
    if (resolveSettleMinutes({ draft_settle_minutes: 1 }) !== 1) throw new Error("1 min not honoured");
    if (resolveSettleMinutes({ draft_settle_minutes: 5 }) !== 5) throw new Error("5 min not honoured");
    if (resolveSettleMinutes({ draft_settle_minutes: 7 }) !== SETTLE_WINDOW_DEFAULT_MINUTES) {
      throw new Error("an unlawful value did not fall to the default");
    }
    if (resolveSettleRealMs({ draft_settle_minutes: 5 }, 60) !== 60_000) {
      throw new Error("the per-conversation override did not win");
    }
    if (resolveSettleRealMs({ draft_settle_minutes: 5 }, 0) !== 0) {
      throw new Error("an instant per-conversation override did not win");
    }
    if (resolveSettleRealMs({ draft_settle_minutes: 1 }, null) !== 60_000) {
      throw new Error("the business setting did not apply without an override");
    }
  });

  await expectOk("the settle clock RESTARTS on each inbound in a burst (timeScale-proven)", async () => {
    const windowMs = 3 * 60 * 1000;
    const t0 = new Date("2026-08-01T10:00:00.000Z");
    const t1 = new Date(t0.getTime() + 2 * 60 * 1000);
    const due0 = new Date(nextSettleDueAt(t0, windowMs));
    const due1 = new Date(nextSettleDueAt(t1, windowMs));
    const scaled = scaleDurationMs(windowMs);
    if (due0.getTime() - t0.getTime() !== scaled) throw new Error("due is not now + the scaled window");
    if (due1.getTime() <= due0.getTime()) throw new Error("a second inbound did not RESTART the window");
    if (due1.getTime() - due0.getTime() !== t1.getTime() - t0.getTime()) {
      throw new Error("the restart did not track the new inbound's moment");
    }
  });

  // --- PR-D/E: the reply register and the cache-marked stable prefix ------
  // JUDGMENT (Session 32, the Q3 ruling applied to the harness): the fee
  // and punctuation belt lines now ride from Light's Memory, so the s18/s31
  // compose fixtures carry the SEEDED memory (exactly what memory-seed.ts
  // writes) — the existing prompt pins then prove the memory-riding path
  // the product actually runs, assertions unchanged. Listed at close.
  const seededMemory: MemoryContext = {
    instructions: [
      { id: "mem-fees", body: FEE_PROHIBITION_LINE.replace(/^-\s*/, "") },
      { id: "mem-register", body: REGISTER_PUNCTUATION_LINE.replace(/^-\s*/, "") },
    ],
    facts: [],
  };

  const s16ReplyInput: ComposeReplyInput = {
    business_name: "Test Firm",
    sign_off: "Test Firm",
    first_name: "Amina",
    full_name: "Amina Khan",
    channel: "email",
    enquiry_title: "Amina Khan — enquiry",
    stage_label: "Contacted",
    form_answers: [{ name: "visa_type", label: "Visa type", value: "Spouse visa" }],
    no_go_rules: [
      "Light never states or implies a guarantee of visa success, application outcome, or Home Office timescales.",
      "Light never gives case-specific legal advice in an unstamped channel.",
    ],
    retrieval: { entries: [], route_matches: ["spouse_family"] },
    thread_messages: [
      { role: "firm", body: "Hello Amina, thank you for your enquiry.", at: "2026-08-01T09:00:00Z", channel: "email" },
      { role: "client", body: "Thanks — how much does a spouse visa application cost?", at: "2026-08-01T10:00:00Z", channel: "email" },
    ],
    new_inbound_count: 1,
    memory: seededMemory,
  };

  await expectOk("the reply prompt carries the register laws, the transcript, and a CACHE-MARKED stable prefix", async () => {
    const { systemBlocks, prompt } = assembleReplyPrompt(s16ReplyInput);
    if (systemBlocks.length !== 2 || !systemBlocks.every((b) => b.cache)) {
      throw new Error("the stable prefix is not two cache-marked blocks");
    }
    if (!/case-specific legal advice is never given/.test(systemBlocks[0]!.text)) {
      throw new Error("the reply register is missing from the stable prefix");
    }
    if (!/Invite a consultation ONLY where the answer genuinely needs one/.test(systemBlocks[0]!.text)) {
      throw new Error("the consultation restraint is missing");
    }
    if (!/never states or implies a guarantee/.test(systemBlocks[0]!.text)) {
      throw new Error("the no-go register is missing from the stable prefix");
    }
    if (!/how much does a spouse visa application cost/.test(prompt)) {
      throw new Error("the client's actual question is not in the uncached tail");
    }
    if (/how much does a spouse visa application cost/.test(systemBlocks.map((b) => b.text).join())) {
      throw new Error("the fresh inbound leaked into the cached prefix");
    }
  });

  await expectOk("a reply about fees escalates (no-go proximity) and the cache figures land on the credit line", async () => {
    let sawBlocks: Array<{ text: string; cache?: boolean }> | undefined;
    const fake: GenerateFn = async (request) => {
      sawBlocks = request.systemBlocks;
      return {
        subject: "Re: your enquiry",
        // Session 18 register rule: fixture bodies obey the law they prove.
        body: "Hello Amina, fees depend on the published schedule, and I would be happy to confirm in a consultation.",
        attestation: { attested: true, statement: "Checked against every law." },
        usage: { input_tokens: 900, output_tokens: 80 },
        cache: { read_tokens: 700, written_tokens: 0 },
      };
    };
    const composed = await composeReplyDraft(fake, s16ReplyInput);
    if (!sawBlocks || !sawBlocks.some((b) => b.cache)) throw new Error("the generator was not handed cache-marked blocks");
    if (composed.credit_line.tier !== "pro" || !/no-go proximity/.test(composed.credit_line.reason)) {
      throw new Error(`a fee question did not escalate: ${composed.credit_line.tier} (${composed.credit_line.reason})`);
    }
    if (composed.credit_line.cache?.read_tokens !== 700) {
      throw new Error("cache figures did not land on the credit line");
    }
  });

  // --- PR-F: the sign-off resolver (WYSIWYS by construction) --------------
  await expectOk("approver sign-off resolves ONLY a known sign-off line, deterministically, render = stamp", async () => {
    if (resolveSignOffMode({}) !== "firm_name") throw new Error("mode default is not firm_name");
    if (resolveSignOffMode({ email_sign_off_mode: "approver" }) !== "approver") throw new Error("approver mode not honoured");
    if (resolveSignOffText({}, "Test Firm") !== "Test Firm") {
      throw new Error("the firm display name is not the shipped default");
    }
    const body = "Hello Amina,\n\nThank you for your message.\n\nKind regards,\nTest Firm";
    const resolved = resolveSignOffBody(body, ["Test Firm"], "Sarah Malik");
    if (resolved !== "Hello Amina,\n\nThank you for your message.\n\nKind regards,\nSarah Malik") {
      throw new Error(`resolution wrong: ${JSON.stringify(resolved)}`);
    }
    // Idempotent: already the approver's name → nothing to change.
    if (resolveSignOffBody(resolved!, ["Test Firm", "Sarah Malik"], "Sarah Malik") !== null) {
      throw new Error("an already-resolved body was re-resolved");
    }
    // A second approver re-resolves from the recorded name.
    const reResolved = resolveSignOffBody(resolved!, ["Test Firm", "Sarah Malik"], "Mudassir");
    if (!reResolved?.endsWith("\nMudassir")) throw new Error("hand-over between approvers failed");
    // A body whose last line is NOT a known sign-off changes NOTHING — what
    // was seen (unresolved) is what sends (unresolved): WYSIWYS trivially.
    if (resolveSignOffBody("Hello,\nNo sign-off here.", ["Test Firm"], "Sarah Malik") !== null) {
      throw new Error("an unknown final line was rewritten — the resolver overreached");
    }
  });

  await expectOk("reference-id parsing reads In-Reply-To/References into RFC ids", async () => {
    const ids = parseReferenceIds([
      "<abc-123@firm.example>",
      "<older@firm.example> <abc-123@firm.example>\r\n <newest@client.example>",
    ]);
    if (ids.length !== 3 || !ids.includes("<newest@client.example>")) {
      throw new Error(`parsed: ${JSON.stringify(ids)}`);
    }
  });

  // ---------------------------------------------------------------------
  // Session 18 — the register rule (founder-ruled): no em or en dashes in
  // generated client-facing bodies. The prompt instructs commas and full
  // stops; the composition screen refuses a body that slips one anyway.
  // Human-authored text is never screened.
  // ---------------------------------------------------------------------
  console.log("\nSession 18 — the client-facing register rule:");

  const s18Input = (task: "intro" | "nudge") => ({
    business_name: "Test Firm", sign_off: "Test Firm", first_name: "Amina", full_name: "Amina Khan",
    channel: "email", task, enquiry_title: "Amina Khan — enquiry", stage_label: "New", source: "meta",
    form_answers: [{ name: "s", label: "Situation", value: "General question" }],
    no_go_rules: [], retrieval: { entries: [], route_matches: [] },
    // Session 32 (D181): the belt lines ride from seeded memory.
    memory: seededMemory,
  });

  await expectOk("both generation prompts instruct commas and full stops, never em or en dashes", async () => {
    let sawSystem = "";
    const fake: GenerateFn = async (request) => {
      sawSystem = request.system;
      return {
        subject: null,
        body: "Hello Amina, thank you for your message. We can help with that.",
        attestation: { attested: true, statement: "Complies." },
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    };
    await composeDraft(fake, s18Input("intro"));
    if (!/Never use an em dash or an en dash/.test(sawSystem)) {
      throw new Error("the intro/nudge prompt does not carry the register punctuation line");
    }
    const { systemBlocks } = assembleReplyPrompt(s16ReplyInput);
    if (!/Never use an em dash or an en dash/.test(systemBlocks[0]!.text)) {
      throw new Error("the reply prompt does not carry the register punctuation line");
    }
  });

  await expectOk("a generated body containing an EM dash is refused at composition (email path)", async () => {
    const fake: GenerateFn = async () => ({
      subject: null,
      body: "Hello Amina, we can help — book a consultation.",
      attestation: { attested: true, statement: "x" },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    let threw = false;
    try {
      await composeDraft(fake, s18Input("intro"));
    } catch (err) {
      threw = err instanceof PermanentGenerationError && /em dash/.test((err as Error).message);
    }
    if (!threw) throw new Error("an em dash survived composition");
  });

  await expectOk("a reply draft containing an EN dash is refused the same way (the free-form path, any channel)", async () => {
    const fake: GenerateFn = async () => ({
      subject: null,
      body: "Hello Amina, appointments run Monday–Friday.",
      attestation: { attested: true, statement: "x" },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    let threw = false;
    try {
      await composeReplyDraft(fake, s16ReplyInput);
    } catch (err) {
      threw = err instanceof PermanentGenerationError && /en dash/.test((err as Error).message);
    }
    if (!threw) throw new Error("an en dash survived reply composition");
  });

  await expectOk("the register screen is machine-scoped: a clean body passes, and the checker itself reads dashes only", async () => {
    if (findRegisterBreach("Commas, and full stops. Hyphenated-words are lawful.") !== null) {
      throw new Error("a hyphen or plain punctuation was misread as a breach");
    }
    if (findRegisterBreach("a — b") !== "em dash" || findRegisterBreach("a – b") !== "en dash") {
      throw new Error("the checker did not name the breach");
    }
  });

  // ---------------------------------------------------------------------
  // Session 19 — multi-touch workflow + HTML email (PR-i..iv) and the
  // inbound-consent ruling fold-in.
  // ---------------------------------------------------------------------
  console.log("\nSession 19 — booking link (PR-iv):");

  await expectOk("[link] resolves to the configured booking URL — WYSIWYS: the stored body carries the real address", async () => {
    const out = substituteBookingLink("You can book here: [link].", "https://xlaw.example/book");
    if (out !== "You can book here: https://xlaw.example/book.") throw new Error(`got: ${out}`);
    if (resolveBookingUrl({ booking_url: " https://xlaw.example/book " }) !== "https://xlaw.example/book") {
      throw new Error("resolveBookingUrl did not accept a lawful https URL");
    }
    if (resolveBookingUrl({ booking_url: "not-a-url" }) !== null || resolveBookingUrl({}) !== null) {
      throw new Error("a malformed or absent booking_url must read as unset");
    }
  });

  await expectError(
    "[link] with no configured booking URL is refused — a client never receives a literal token",
    /no booking URL/,
    async () => substituteBookingLink("Book here: [link]", null)
  );

  await expectOk("composition substitutes the booking URL into the generated body, and the prompt invites the token only when configured", async () => {
    let sawSystem = "";
    const fake: GenerateFn = async (request) => {
      sawSystem = request.system;
      return {
        subject: null,
        body: "Hello Amina, we can help. Book a consultation here: [link].",
        attestation: { attested: true, statement: "Complies." },
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    };
    const composed = await composeDraft(fake, { ...s18Input("intro"), booking_url: "https://xlaw.example/book" });
    // Session 31: the tripwire targets the [link] invitation itself — the
    // D179a fee line mentions "the booking page" in every prompt.
    if (!/writing the token \[link\]/.test(sawSystem)) throw new Error("the prompt does not carry the booking-link line when configured");
    if (!composed.body.includes("https://xlaw.example/book") || composed.body.includes("[link]")) {
      throw new Error(`the token did not resolve: ${composed.body}`);
    }
    await composeDraft(fake, s18Input("intro")).then(
      () => {
        throw new Error("a [link] body with no booking URL must be refused");
      },
      (err) => {
        if (!(err instanceof PermanentGenerationError && /no booking URL/.test(err.message))) throw err;
      }
    );
    let unconfiguredSystem = "";
    const cleanFake: GenerateFn = async (request) => {
      unconfiguredSystem = request.system;
      return {
        subject: null,
        body: "Hello Amina, we can help with that.",
        attestation: { attested: true, statement: "Complies." },
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    };
    await composeDraft(cleanFake, s18Input("intro"));
    if (/writing the token \[link\]/.test(unconfiguredSystem)) {
      throw new Error("the prompt invites [link] with no booking URL configured");
    }
  });

  console.log("\nSession 19 — the HTML email dress (PR-iii):");

  const s19DressBody =
    "Hello Amina, thank you for your enquiry with X Law.\nWe will call you shortly.\n\n" +
    "You can book here: https://xlaw.example/book and ask about fees & timings <at any point>.\n\n" +
    "X Law";
  const s19Identity = resolveEmailIdentity("X Law", { regulated_status: "IAA Level 2 (casework)" });

  await expectOk("html/plain parity from ONE body — the deterministic inverse returns exactly the plain source", async () => {
    const html = renderEmailHtml(s19DressBody, s19Identity);
    const back = extractEmailPlainText(html);
    if (back !== s19DressBody) {
      throw new Error(`parity broken.\n--- body:\n${s19DressBody}\n--- extracted:\n${back}`);
    }
    if (plainTextOfBody(html, "html") !== s19DressBody) throw new Error("plainTextOfBody(html) disagrees");
    if (plainTextOfBody(s19DressBody, "plain") !== s19DressBody) throw new Error("plain rows must pass through untouched");
  });

  await expectOk("the dress is minimal and honest: firm footer + regulated line, links only, no images and no tracking, escaped markup", async () => {
    const html = renderEmailHtml(s19DressBody, s19Identity);
    if (!html.includes("X Law") || !html.includes("IAA Level 2 (casework)")) {
      throw new Error("the firm/regulated footer lines are missing");
    }
    if (!/<a href="https:\/\/xlaw\.example\/book"/.test(html)) throw new Error("the URL was not linkified");
    if (/<img|<script|pixel|track/i.test(html)) throw new Error("chrome/images/tracking found in the dress");
    if (!html.includes("&lt;at any point&gt;") || !html.includes("&amp;")) {
      throw new Error("body markup was not escaped");
    }
    const bare = renderEmailHtml("Hello.", resolveEmailIdentity("X Law", {}));
    if (/IAA|regulated/i.test(bare)) throw new Error("an unset regulated status must render NO line — honest absence");
  });

  console.log("\nSession 19 — the ATTACHMENTS pre-flight (PR-i):");

  await expectOk("the declared vocabulary carries route_guide (0032 — documents are entries with a file)", async () => {
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from private.drafting_field_declarations() d
       where d.key = 'knowledge_category'
         and d.validation -> 'allowed' @> '[{"key": "route_guide"}]'::jsonb`
    );
    if (r.rows[0]!.n !== 1) throw new Error("route_guide is not declared");
  });

  // A fresh consented contact + engagement for the attachment and
  // multi-touch tests — no leftovers from earlier sections.
  const s19Contact = await db.query<{ id: string }>(
    `insert into public.contacts (business_id, created_by, type, display_name, given_name)
     values ($1, $2, 'person', 'Sana Iqbal', 'Sana') returning id`,
    [f.business_id, f.agent_id]
  );
  const s19ContactId = s19Contact.rows[0]!.id;
  await db.query(
    `insert into public.contact_channels (business_id, created_by, contact_id, channel, value, is_primary, consent)
     values ($1, $2, $3, 'email', 'sana@example.test', true, '{"transactional": true}'::jsonb),
            ($1, $2, $3, 'whatsapp', '+447700900123', true, '{"transactional": true}'::jsonb)`,
    [f.business_id, f.agent_id, s19ContactId]
  );
  const s19Engagement = await db.query<{ id: string }>(
    `insert into public.engagements (business_id, created_by, template_type_id, title, stage_id, owner_actor_id)
     values ($1, $2, $3, 'Sana Iqbal — enquiry', $4, $5) returning id`,
    [f.business_id, f.agent_id, f.type_id, f.stage_id, f.human_id]
  );
  const s19EngagementId = s19Engagement.rows[0]!.id;
  const s19EmailThread = await db.query<{ id: string }>(
    `insert into public.comm_threads (business_id, created_by, contact_id, engagement_id, channel)
     values ($1, $2, $3, $4, 'email') returning id`,
    [f.business_id, f.agent_id, s19ContactId, s19EngagementId]
  );
  const s19EmailThreadId = s19EmailThread.rows[0]!.id;

  const s19DeclareDraft = async (attachments: unknown): Promise<string> => {
    const r = await db.query<{ id: string }>(
      `insert into public.communications
         (business_id, created_by, thread_id, contact_id, engagement_id, channel, direction, status, body, drafted_by_actor_id, attributes)
       values ($1, $2, $3, $4, $5, 'email', 'outbound', 'draft', 'Hello Sana, our guide is attached for your route.', $2, $6::jsonb)
       returning id`,
      [f.business_id, f.agent_id, s19EmailThreadId, s19ContactId, s19EngagementId, JSON.stringify({ attachments })]
    );
    const commId = r.rows[0]!.id;
    await db.query(`select public.submit_communication($1, $2)`, [commId, f.agent_id]);
    await recordCompliance(commId);
    return commId;
  };

  const s19MissingFileId = "00000000-0000-7000-8000-00000000dead";
  const s19MissingComm = await s19DeclareDraft([
    { file_id: s19MissingFileId, filename: "spouse-guide.pdf", mime_type: "application/pdf", size_bytes: 1024 },
  ]);
  await expectError(
    "REFUSAL: a declared attachment whose file does not exist blocks the stamp (PR-i's ordered proof)",
    /does not exist/,
    () => db.query(`select public.approve_communication($1, $2)`, [s19MissingComm, f.human_id])
  );
  await db.query(`select public.reject_communication($1, $2, $3)`, [s19MissingComm, f.human_id, "harness cleanup — the refusal is the proof"]);

  const s19File = await db.query<{ id: string }>(
    `insert into public.files (business_id, storage_key, filename, mime_type, size_bytes, sha256, uploaded_by)
     values ($1, 'route-guides/test/spouse-guide.pdf', 'spouse-guide.pdf', 'application/pdf', 2048, repeat('b', 64), $2) returning id`,
    [f.business_id, f.agent_id]
  );
  const s19FileId = s19File.rows[0]!.id;

  const s19UnlinkedComm = await s19DeclareDraft([
    { file_id: s19FileId, filename: "spouse-guide.pdf", mime_type: "application/pdf", size_bytes: 2048 },
  ]);
  await expectError(
    "REFUSAL: a declared attachment that exists but is NOT LINKED to the message blocks the stamp",
    /not linked/,
    () => db.query(`select public.approve_communication($1, $2)`, [s19UnlinkedComm, f.human_id])
  );
  await expectOk("linking the declared file earns the stamp — existence + linkage is the whole check", async () => {
    await db.query(
      `insert into public.file_links (business_id, file_id, entity_type, entity_id, role)
       values ($1, $2, 'communication', $3, 'attachment')`,
      [f.business_id, s19FileId, s19UnlinkedComm]
    );
    await db.query(`select public.approve_communication($1, $2)`, [s19UnlinkedComm, f.human_id]);
  });

  await expectError(
    "REFUSAL: a declared attachment over the 8MB ceiling blocks the stamp (the visible config error)",
    /8MB/,
    async () => {
      const big = await db.query<{ id: string }>(
        `insert into public.files (business_id, storage_key, filename, mime_type, size_bytes, sha256, uploaded_by)
         values ($1, 'route-guides/test/oversize.pdf', 'oversize.pdf', 'application/pdf', ${9 * 1024 * 1024}, repeat('c', 64), $2) returning id`,
        [f.business_id, f.agent_id]
      );
      const commId = await s19DeclareDraft([
        { file_id: big.rows[0]!.id, filename: "oversize.pdf", mime_type: "application/pdf", size_bytes: 9 * 1024 * 1024 },
      ]);
      await db.query(
        `insert into public.file_links (business_id, file_id, entity_type, entity_id, role)
         values ($1, $2, 'communication', $3, 'attachment')`,
        [f.business_id, big.rows[0]!.id, commId]
      );
      try {
        await db.query(`select public.approve_communication($1, $2)`, [commId, f.human_id]);
      } finally {
        await db.query(`select public.reject_communication($1, $2, $3)`, [commId, f.human_id, "harness cleanup"]);
      }
    }
  );

  console.log("\nSession 19 — multi-touch two-stamp independence (PR-ii):");

  const s19WaThread = await db.query<{ id: string }>(
    `insert into public.comm_threads (business_id, created_by, contact_id, engagement_id, channel)
     values ($1, $2, $3, $4, 'whatsapp') returning id`,
    [f.business_id, f.agent_id, s19ContactId, s19EngagementId, ]
  );
  const s19Intro = await db.query<{ id: string }>(
    `insert into public.communications
       (business_id, created_by, thread_id, contact_id, engagement_id, channel, direction, status, body, drafted_by_actor_id)
     values ($1, $2, $3, $4, $5, 'email', 'outbound', 'draft', 'Hello Sana, thank you for your enquiry with X Law.', $2) returning id`,
    [f.business_id, f.agent_id, s19EmailThreadId, s19ContactId, s19EngagementId]
  );
  const s19IntroId = s19Intro.rows[0]!.id;
  const s19WaIntro = await db.query<{ id: string }>(
    `insert into public.communications
       (business_id, created_by, thread_id, contact_id, engagement_id, channel, direction, status, body, drafted_by_actor_id, attributes)
     values ($1, $2, $3, $4, $5, 'whatsapp', 'outbound', 'draft', 'Hello Sana, thank you for your enquiry with X Law.', $2,
             '{"wa_template": {"name": "enquiry_intro", "language": "en_GB"}, "companion": "whatsapp"}'::jsonb) returning id`,
    [f.business_id, f.agent_id, s19WaThread.rows[0]!.id, s19ContactId, s19EngagementId]
  );
  const s19WaIntroId = s19WaIntro.rows[0]!.id;

  await expectOk("the intro pair pends TOGETHER — one per channel, the 0029 guard permits exactly this shape", async () => {
    await db.query(`select public.submit_communication($1, $2)`, [s19IntroId, f.agent_id]);
    await recordCompliance(s19IntroId);
    await db.query(`select public.submit_communication($1, $2)`, [s19WaIntroId, f.agent_id]);
    await recordCompliance(s19WaIntroId);
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from public.communications
       where engagement_id = $1 and status = 'pending_approval' and direction = 'outbound'`,
      [s19EngagementId]
    );
    if (r.rows[0]!.n !== 2) throw new Error(`expected 2 pending drafts, saw ${r.rows[0]!.n}`);
  });

  await expectOk("stamping the EMAIL intro leaves the WhatsApp intro pending — two individual stamps, never one act", async () => {
    await db.query(`select public.approve_communication($1, $2)`, [s19IntroId, f.human_id]);
    const r = await db.query<{ status: string }>(`select status from public.communications where id = $1`, [s19WaIntroId]);
    if (r.rows[0]!.status !== "pending_approval") {
      throw new Error(`the WhatsApp intro moved with the email stamp: ${r.rows[0]!.status}`);
    }
  });

  await expectOk("refusing the WhatsApp intro leaves the stamped email untouched — the touches are independent", async () => {
    await db.query(`select public.reject_communication($1, $2, $3)`, [s19WaIntroId, f.human_id, "Not this lead — email is enough."]);
    const r = await db.query<{ status: string }>(`select status from public.communications where id = $1`, [s19IntroId]);
    if (r.rows[0]!.status !== "approved") throw new Error(`the email intro was disturbed: ${r.rows[0]!.status}`);
  });

  console.log("\nSession 19 — inbound WhatsApp consent (founder-ruled fold-in):");

  await expectOk("an inbound message earns TRANSACTIONAL consent only — marketing is never inferred, prior values pass through", async () => {
    const window = { opened_at: "2026-08-01T10:00:00Z", expires_at: "2026-08-02T10:00:00Z", source: "whatsapp_inbound" };
    const fresh = whatsAppInboundConsent(null, "2026-08-01T10:00:00Z", window);
    if (fresh.transactional !== true || fresh.source !== "inbound_message") throw new Error("fresh consent is wrong");
    if ("marketing" in fresh) throw new Error("marketing consent was invented from an inbound message");
    const merged = whatsAppInboundConsent({ marketing: false, note: "kept" }, "2026-08-01T10:00:00Z", window);
    if (merged.marketing !== false || merged.note !== "kept") throw new Error("prior consent values were disturbed");
    if (merged.transactional !== true) throw new Error("transactional consent was not granted");
  });

  await expectOk("the DEFECT case, then the law: a lead-form contact's WhatsApp reply draft is refused on consent until the inbound's consent row lands — then the stamp is earned", async () => {
    // A lead-form contact: phone + email consent only (the live shape).
    const lead = await db.query<{ id: string }>(
      `insert into public.contacts (business_id, created_by, type, display_name, given_name)
       values ($1, $2, 'person', 'Bilal Ahmed', 'Bilal') returning id`,
      [f.business_id, f.agent_id]
    );
    const leadId = lead.rows[0]!.id;
    await db.query(
      `insert into public.contact_channels (business_id, created_by, contact_id, channel, value, is_primary, consent)
       values ($1, $2, $3, 'phone', '+447700900456', true, '{"transactional": true, "marketing": true, "source": "meta_lead_form"}'::jsonb),
              ($1, $2, $3, 'email', 'bilal@example.test', true, '{"transactional": true, "marketing": true, "source": "meta_lead_form"}'::jsonb)`,
      [f.business_id, f.agent_id, leadId]
    );
    const waThread = await db.query<{ id: string }>(
      `insert into public.comm_threads (business_id, created_by, contact_id, channel)
       values ($1, $2, $3, 'whatsapp') returning id`,
      [f.business_id, f.agent_id, leadId]
    );
    // The client's first inbound WhatsApp message (in-window).
    await db.query(
      `insert into public.communications (business_id, created_by, thread_id, contact_id, channel, direction, status, body, occurred_at)
       values ($1, $2, $3, $4, 'whatsapp', 'inbound', 'received', 'Salaam, can you help with my spouse visa?', now())`,
      [f.business_id, f.agent_id, waThread.rows[0]!.id, leadId]
    );
    // Light's free-form reply draft.
    const reply = await db.query<{ id: string }>(
      `insert into public.communications (business_id, created_by, thread_id, contact_id, channel, direction, status, body, drafted_by_actor_id)
       values ($1, $2, $3, $4, 'whatsapp', 'outbound', 'draft', 'Hello Bilal, yes, we help with spouse visa applications.', $2) returning id`,
      [f.business_id, f.agent_id, waThread.rows[0]!.id, leadId]
    );
    const replyId = reply.rows[0]!.id;
    await db.query(`select public.submit_communication($1, $2)`, [replyId, f.agent_id]);
    await recordCompliance(replyId);

    // The defect the founder caught live: the WA WINDOW passes (an inbound
    // is in-window) while CONSENT refuses — two checks disagreeing about
    // the same fact.
    let refused = false;
    try {
      await db.query(`select public.approve_communication($1, $2)`, [replyId, f.human_id]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/session window/.test(message)) throw new Error("the WA window check refused — the defect was elsewhere");
      refused = /consent/i.test(message);
    }
    if (!refused) throw new Error("the defect case did not refuse on consent");

    // The ruling's fix: ingest writes the consent row the inbound earned.
    await db.query(
      `insert into public.contact_channels (business_id, created_by, contact_id, channel, value, is_primary, consent)
       values ($1, $2, $3, 'whatsapp', '+447700900456', true, $4::jsonb)`,
      [
        f.business_id,
        f.agent_id,
        leadId,
        JSON.stringify(whatsAppInboundConsent(null, new Date().toISOString(), {
          opened_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
          source: "whatsapp_inbound",
        })),
      ]
    );
    await db.query(`select public.approve_communication($1, $2)`, [replyId, f.human_id]);
  });

  // ---------------------------------------------------------------------
  console.log("\nHotfix (1 Aug 2026) — guide documents on any route entry + the upload transport:");

  await expectOk("ANY published route-matched entry bearing a file qualifies — category no longer filters (founder ruling)", async () => {
    const entries = [
      {
        id: "old-guide",
        title: "Spouse guide (separate row)",
        attributes: { knowledge_category: "route_guide", visa_route: "spouse_partner" },
        created_at: "2026-07-01T00:00:00Z",
      },
      {
        id: "spouse-entry",
        title: "Spouse route (text AND document)",
        attributes: { knowledge_category: "service_description", visa_route: "spouse_partner" },
        created_at: "2026-08-01T00:00:00Z",
      },
      {
        id: "fees",
        title: "Published fees (no route)",
        attributes: { knowledge_category: "fees" },
        created_at: "2026-08-01T00:00:00Z",
      },
    ];
    const ranked = rankGuideCandidates(entries, ["spouse_partner"]);
    if (ranked.length !== 2) throw new Error(`expected 2 candidates, saw ${ranked.length}`);
    if (ranked[0]!.id !== "spouse-entry") {
      throw new Error("the founder's newest curation must be tried first (newest-first within a route)");
    }
    if (ranked[1]!.id !== "old-guide") throw new Error("the route_guide row must remain a valid candidate");
    if (ranked.some((c) => c.id === "fees")) throw new Error("a route-less entry can never carry the intro's attachment");
  });

  await expectOk("route priority outranks recency — the enquiry's declared route is tried before lead-text matches", async () => {
    const ranked = rankGuideCandidates(
      [
        { id: "sw-new", title: "SW", attributes: { visa_route: "skilled_worker" }, created_at: "2026-08-01T00:00:00Z" },
        { id: "sp-old", title: "SP", attributes: { visa_route: "spouse_partner" }, created_at: "2026-07-01T00:00:00Z" },
      ],
      ["spouse_partner", "skilled_worker"]
    );
    if (ranked[0]!.id !== "sp-old") throw new Error("the declared route's guide must be tried first");
  });

  await expectOk("the server-action transport admits the 8MB attachment law — bodySizeLimit covers the ceiling (the 413 tripwire)", async () => {
    // cwd is packages/db (the workspace script), matching the migrations read.
    const config = readFileSync(resolve("../../apps/web/next.config.ts"), "utf8");
    const match = config.match(/bodySizeLimit:\s*"(\d+)mb"/);
    if (!match) throw new Error("next.config.ts declares no serverActions.bodySizeLimit — the 1MB default caps uploads below the enforced 8MB law (the 413 defect)");
    const transportBytes = Number(match[1]) * 1024 * 1024;
    if (transportBytes <= ATTACHMENT_MAX_BYTES) {
      throw new Error(`transport limit ${match[1]}mb must exceed the 8MB app ceiling — the transport is not a gate`);
    }
  });

  // ---------------------------------------------------------------------
  console.log("\nSession 20 — provider selection isolation (WS2):");

  const fakeCarrier = (provider: string) => async (): Promise<SendResult> => ({
    provider,
    providerMessageId: `<fake@${provider}>`,
  });

  await expectOk("mail_provider resolves gmail ONLY on the literal — unknown values can never route mail to an unintended carrier", async () => {
    if (resolveMailProvider(undefined) !== "graph") throw new Error("absent settings must default to graph");
    if (resolveMailProvider({}) !== "graph") throw new Error("empty settings must default to graph");
    if (resolveMailProvider({ mail_provider: "gmail" }) !== "gmail") throw new Error("gmail selection was not honoured");
    if (resolveMailProvider({ mail_provider: "outlook" }) !== "graph") throw new Error("an unknown value must read as the graph default");
  });

  await expectOk("a Graph business never touches Gmail paths and vice versa — selection is absolute, no cross-provider fallback", async () => {
    const graphSend = fakeCarrier("graph");
    const gmailSend = fakeCarrier("gmail");
    const both: OutboundProviders = { sendEmail: graphSend, sendGmail: gmailSend };
    if (selectEmailCarrier(both, {}).send !== graphSend) throw new Error("a graph business must get the graph carrier");
    if (selectEmailCarrier(both, { mail_provider: "gmail" }).send !== gmailSend) {
      throw new Error("a gmail business must get the gmail carrier");
    }
    // The isolation refusals: the OTHER provider's carrier is never a fallback.
    const graphOnly: OutboundProviders = { sendEmail: graphSend };
    const gmailChoice = selectEmailCarrier(graphOnly, { mail_provider: "gmail" });
    if (gmailChoice.send !== null) throw new Error("a gmail business must NEVER fall back to the graph carrier");
    if (gmailChoice.provider !== "gmail") throw new Error("the visible skip must name the selected provider");
    const gmailOnly: OutboundProviders = { sendGmail: gmailSend };
    if (selectEmailCarrier(gmailOnly, {}).send !== null) {
      throw new Error("a graph business must NEVER fall back to the gmail carrier");
    }
  });

  console.log("\nSession 20 — the Gmail inbound claims (0033):");

  await expectOk("gmail claims: idempotent on the RFC message id; invisible and closed to signed-in sessions", async () => {
    await db.query(
      `insert into public.gmail_mail_events (internet_message_id, gmail_message_id, mailbox)
       values ('<s20@example.test>', 'gm-1', 'firm@workspace.test')`
    );
    let threw = false;
    try {
      await db.query(`insert into public.gmail_mail_events (internet_message_id) values ('<s20@example.test>')`);
    } catch (err) {
      threw = /duplicate key/.test(err instanceof Error ? err.message : String(err));
    }
    if (!threw) throw new Error("a replayed RFC id claimed twice — the poll would double-ingest");
    const n = await db.query<{ n: number }>(`select count(*)::int as n from public.gmail_mail_events`);
    if (n.rows[0]!.n !== 1) throw new Error("the duplicate changed the claim table");
    await db.exec(`set role authenticated`);
    await db.exec(`set request.jwt.claim.sub = '${ids.user}'`);
    try {
      const visible = await db.query<{ n: number }>(`select count(*)::int as n from public.gmail_mail_events`);
      if (visible.rows[0]!.n !== 0) throw new Error("a signed-in session can read raw provider claims");
      let insertRefused = false;
      try {
        await db.query(`insert into public.gmail_mail_events (internet_message_id) values ('<forged@example.test>')`);
      } catch (err) {
        insertRefused = /row-level security|permission denied/.test(err instanceof Error ? err.message : String(err));
      }
      if (!insertRefused) throw new Error("a signed-in session wrote a claim row");
    } finally {
      await db.exec(`reset role`);
      await db.exec(`set request.jwt.claim.sub = ''`);
    }
  });

  console.log("\nSession 20 — allowlist parity across providers (WS1):");

  await expectOk("the door reads the EMAIL, never the provider — the same allowed address opens under google and azure alike", async () => {
    await db.query(`insert into public.allowed_emails (email, note) values ('parity@example.test', 's20 parity smoke')`);
    const claimsFor = (provider: string) =>
      JSON.stringify({
        sub: ids.user,
        email: "parity@example.test",
        app_metadata: { provider, providers: [provider] },
      });
    await db.exec(`set role authenticated`);
    try {
      for (const provider of ["google", "azure"]) {
        await db.exec(`set request.jwt.claims = '${claimsFor(provider)}'`);
        const r = await db.query<{ n: number }>(`select count(*)::int as n from public.allowed_emails`);
        if (r.rows[0]!.n !== 1) throw new Error(`the ${provider} door saw ${r.rows[0]!.n} rows — parity broken`);
      }
      // The refusal, same parity: an unallowed email is refused through
      // EITHER door — the provider buys nothing.
      for (const provider of ["google", "azure"]) {
        await db.exec(
          `set request.jwt.claims = '${JSON.stringify({ sub: ids.member, email: "stranger-s20@example.test", app_metadata: { provider } })}'`
        );
        const r = await db.query<{ n: number }>(`select count(*)::int as n from public.allowed_emails`);
        if (r.rows[0]!.n !== 0) throw new Error(`an unallowed ${provider} account saw an allowlist row`);
      }
    } finally {
      await db.exec(`reset role`);
    }
  });

  console.log("\nSession 20 — the Gmail carriage document (pure MIME):");

  await expectOk("buildGmailMime carries the self-minted Message-ID, the addressed headers, and a body that decodes back verbatim", async () => {
    const mime = buildGmailMime({
      from: "firm@workspace.test",
      to: "client@example.test",
      subject: "Your enquiry with X Law",
      body: "Hello Sana,\n\nThank you for your enquiry.",
      bodyFormat: "plain",
      messageId: "<mint-1@workspace.test>",
    });
    if (!mime.includes("Message-ID: <mint-1@workspace.test>")) throw new Error("the self-minted Message-ID is missing — replies could never thread");
    if (!mime.includes("To: client@example.test") || !mime.includes("From: firm@workspace.test")) {
      throw new Error("addressing headers missing");
    }
    if (!mime.includes("Content-Type: text/plain")) throw new Error("a plain body must ride text/plain");
    const b64 = mime.split("\r\n\r\n")[1]!.replace(/\r\n/g, "");
    if (Buffer.from(b64, "base64").toString("utf8") !== "Hello Sana,\n\nThank you for your enquiry.") {
      throw new Error("the body did not decode back verbatim — WYSIWYS broken at the carriage layer");
    }
    const html = buildGmailMime({
      from: "firm@workspace.test",
      to: "client@example.test",
      subject: "Your enquiry",
      body: "<p>Hello</p>",
      bodyFormat: "html",
      messageId: "<mint-2@workspace.test>",
    });
    if (!html.includes("Content-Type: text/html")) throw new Error("an html body must ride text/html");
  });

  await expectOk("attachments ride as named multipart parts and non-ASCII subjects are RFC 2047 encoded", async () => {
    const pdfBytes = Buffer.from("%PDF-1.4 fake guide").toString("base64");
    const mime = buildGmailMime({
      from: "firm@workspace.test",
      to: "client@example.test",
      subject: "Guide — attachéd",
      body: "The guide is attached.",
      bodyFormat: "plain",
      messageId: "<mint-3@workspace.test>",
      attachments: [{ filename: "spouse-guide.pdf", mimeType: "application/pdf", contentBase64: pdfBytes }],
    });
    if (!mime.includes("multipart/mixed")) throw new Error("an attachment demands multipart/mixed");
    if (!mime.includes('filename="spouse-guide.pdf"')) throw new Error("the attachment part is unnamed");
    if (!mime.includes(pdfBytes.slice(0, 40))) throw new Error("the attachment bytes are not in the document");
    if (!/Subject: =\?UTF-8\?B\?/.test(mime)) throw new Error("a non-ASCII subject must be RFC 2047 encoded");
  });

  await expectOk("extractGmailBodyText prefers the nested text/plain part and honestly strips html-only mail to its words", async () => {
    const plain = extractGmailBodyText({
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/html", body: { data: Buffer.from("<b>Hi</b>").toString("base64url") } },
        {
          mimeType: "multipart/related",
          parts: [{ mimeType: "text/plain", body: { data: Buffer.from("Hi there").toString("base64url") } }],
        },
      ],
    });
    if (plain !== "Hi there") throw new Error(`expected the nested plain part, saw "${plain}"`);
    const stripped = extractGmailBodyText({
      mimeType: "text/html",
      body: { data: Buffer.from("<p>Salaam,</p><p>Can you &amp; the team help?</p>").toString("base64url") },
    });
    if (!stripped.includes("Salaam,") || !stripped.includes("Can you & the team help?") || /<p>/.test(stripped)) {
      throw new Error(`html-only mail must yield the words, never markup: "${stripped}"`);
    }
  });

  // ---------------------------------------------------------------------
  // Session 21 — the stuck-definition escape hatch (0034): an OWNER may
  // withdraw a pending_approval definition; withdrawn is terminal, frozen,
  // never deletable, and a withdrawn definition never executes. The ordered
  // coverage: terminal + evented reason on the row; never executes; the
  // Withdraw control renders only for pending definitions and only to the
  // owner (the pure render-gate, the s20 selectEmailCarrier pattern).
  // ---------------------------------------------------------------------
  console.log("\nSession 21 — the stuck-definition escape hatch (0034):");

  const s21Pending = await db.query<{ id: string }>(
    `insert into public.workflow_definitions (business_id, created_by, key, template_id, status, description_plain)
     values ($1, $2, 'wf_withdraw_test', $3, 'pending_approval', 'A stranded proposal awaiting the escape hatch.')
     returning id`,
    [f.business_id, f.human_id, f.template_id]
  );
  const s21PendingId = s21Pending.rows[0]!.id;
  const s21Draft = await db.query<{ id: string }>(
    `insert into public.workflow_definitions (business_id, created_by, key, template_id, status, description_plain)
     values ($1, $2, 'wf_withdraw_draft', $3, 'draft', 'A draft — not withdrawable.')
     returning id`,
    [f.business_id, f.human_id, f.template_id]
  );
  const s21DraftId = s21Draft.rows[0]!.id;

  await expectError("withdrawal requires a reason — it is recorded on the row and the ledger", /reason/, () =>
    db.query(`select public.withdraw_workflow_definition($1, $2, '   ')`, [s21PendingId, f.human_id])
  );

  // Owner ONLY (founder-ruled): even a human holding the workflow stamp is
  // refused — withdrawing is not a stamp act, and the stamps stay absent
  // until the definition-approval pipeline's own session.
  await db.query(grantSql, [f.business_id, f.human_id, h2.human2_id, "approvals.workflows", "execute", bizScope, "standing", null, f.human_id, "chat"]);
  await expectError("a non-owner member cannot withdraw, even holding approvals.workflows", /owner/, () =>
    db.query(`select public.withdraw_workflow_definition($1, $2, 'not my call')`, [s21PendingId, h2.human2_id])
  );
  await expectError("an agent cannot withdraw a definition", /owner/, () =>
    db.query(`select public.withdraw_workflow_definition($1, $2, 'machine overreach')`, [s21PendingId, f.agent_id])
  );

  await expectError("only a stamp-awaiting definition can be withdrawn — a draft is refused", /stamp-awaiting/, () =>
    db.query(`select public.withdraw_workflow_definition($1, $2, 'wrong state')`, [s21DraftId, f.human_id])
  );

  await expectError("no definition is born withdrawn", /born withdrawn/, () =>
    db.query(
      `insert into public.workflow_definitions (business_id, created_by, key, template_id, status, description_plain)
       values ($1, $2, 'wf_born_withdrawn', $3, 'withdrawn', 'Should never exist.')`,
      [f.business_id, f.human_id, f.template_id]
    )
  );
  await expectError("withdrawal columns cannot be smuggled onto a birth", /born withdrawn/, () =>
    db.query(
      `insert into public.workflow_definitions (business_id, created_by, key, template_id, status, description_plain, withdrawn_at, withdrawn_by_actor_id, withdrawal_reason)
       values ($1, $2, 'wf_smuggled_withdrawal', $3, 'draft', 'Should never exist.', now(), $2, 'smuggled')`,
      [f.business_id, f.human_id, f.template_id]
    )
  );

  await expectError("status never moves to withdrawn by direct update, even for the superuser", /moves only through/, () =>
    db.query(`update public.workflow_definitions set status = 'withdrawn' where id = $1`, [s21PendingId])
  );

  await expectOk("the owner withdraws a pending definition — terminal, reason recorded on the row, gone from the inbox", async () => {
    const before = await db.query<{ n: number }>(
      `select count(*)::int as n from public.approval_inbox where item_id = $1`,
      [s21PendingId]
    );
    if (before.rows[0]!.n !== 1) throw new Error("the pending definition should sit in the inbox before withdrawal");
    await db.query(`select public.withdraw_workflow_definition($1, $2, 'superseded by a later version')`, [
      s21PendingId,
      f.human_id,
    ]);
    const r = await db.query<{
      status: string;
      withdrawn_at: string | null;
      withdrawn_by_actor_id: string | null;
      withdrawal_reason: string | null;
    }>(
      `select status, withdrawn_at, withdrawn_by_actor_id, withdrawal_reason from public.workflow_definitions where id = $1`,
      [s21PendingId]
    );
    const row = r.rows[0]!;
    if (row.status !== "withdrawn") throw new Error(`status is ${row.status}`);
    if (!row.withdrawn_at || row.withdrawn_by_actor_id !== f.human_id) throw new Error("who/when not recorded");
    if (row.withdrawal_reason !== "superseded by a later version") throw new Error("the reason is not on the row");
    const after = await db.query<{ n: number }>(
      `select count(*)::int as n from public.approval_inbox where item_id = $1`,
      [s21PendingId]
    );
    if (after.rows[0]!.n !== 0) throw new Error("a withdrawn definition is still in the inbox");
  });

  await expectError("withdrawn is terminal — the approve pipeline refuses it", /stamp-awaiting/, () =>
    db.query(`select public.approve_workflow_definition($1, $2)`, [s21PendingId, f.human_id])
  );
  await expectError("withdrawn is terminal — the reject pipeline refuses it", /stamp-awaiting/, () =>
    db.query(`select public.reject_workflow_definition($1, $2, 'too late')`, [s21PendingId, f.human_id])
  );
  await expectError("withdrawn is terminal — it cannot be re-submitted", /draft definitions/, () =>
    db.query(`select public.submit_workflow_definition($1, $2)`, [s21PendingId, f.human_id])
  );
  await expectError("withdrawn is terminal — it cannot be withdrawn twice", /stamp-awaiting/, () =>
    db.query(`select public.withdraw_workflow_definition($1, $2, 'again')`, [s21PendingId, f.human_id])
  );
  await expectError("a withdrawn row is frozen — no update of any kind lands", /never left|never changes/, () =>
    db.query(`update public.workflow_definitions set attributes = '{"touched":true}'::jsonb where id = $1`, [
      s21PendingId,
    ])
  );
  await expectError("a withdrawn definition is never deleted — the Record never purges", /never purges|never deleted/, () =>
    db.query(`delete from public.workflow_definitions where id = $1`, [s21PendingId])
  );

  await expectError("a withdrawn definition never executes — start_workflow_run refuses it", /active/, () =>
    db.query(`select public.start_workflow_run($1, $2, $3)`, [s21PendingId, engagementId, f.agent_id])
  );
  await expectOk("the trigger scan's active-only filter never sees a withdrawn definition", async () => {
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from public.workflow_definitions
       where status = 'active' and archived_at is null and id = $1`,
      [s21PendingId]
    );
    if (r.rows[0]!.n !== 0) throw new Error("the scan filter matched a withdrawn definition");
  });

  await expectOk("the Withdraw control renders only for pending definitions and only to the owner", async () => {
    if (!canWithdrawWorkflowDefinition({ status: "pending_approval", isOwner: true })) {
      throw new Error("the owner must be offered Withdraw on a pending definition");
    }
    if (canWithdrawWorkflowDefinition({ status: "pending_approval", isOwner: false })) {
      throw new Error("a non-owner must never see the control");
    }
    for (const status of ["draft", "active", "paused", "withdrawn"]) {
      if (canWithdrawWorkflowDefinition({ status, isOwner: true })) {
        throw new Error(`a ${status} definition must never offer Withdraw`);
      }
    }
  });

  // Session 22 (WS1) — the Meta Conversions loop: the founder-ruled mapping,
  // hashing law and isolation proven at the pure seams the sweep runs on.
  console.log("\nSession 22 — the Meta Conversions loop (WS1):");

  const s22Config = { enabled: true, dataset_id: "1234567890", test_event_code: "TEST99" };
  const s22Facts = new Map([
    [
      "eng-meta",
      {
        engagement_id: "eng-meta",
        source: "meta",
        leadgen_id: "444455556666777",
        email: " Ayesha.Khan@Example.COM ",
        phone: "+44 7700 900123",
        invoice: null,
      },
    ],
    [
      "eng-meta-fee",
      {
        engagement_id: "eng-meta-fee",
        source: "meta",
        leadgen_id: "444455556666778",
        email: "lead2@example.com",
        phone: "+447700900124",
        invoice: { total: 1500, currency: "GBP" },
      },
    ],
    [
      "eng-organic",
      {
        engagement_id: "eng-organic",
        source: "website",
        leadgen_id: null,
        email: "organic@example.com",
        phone: null,
        invoice: null,
      },
    ],
  ]);
  const s22Now = new Date("2026-08-01T12:00:00Z");
  const s22Moves = [
    { stage_history_id: "sh-1", engagement_id: "eng-meta", to_stage_key: "consultation_booked", moved_at: "2026-08-01T11:00:00Z" },
    { stage_history_id: "sh-2", engagement_id: "eng-meta-fee", to_stage_key: "instructed", moved_at: "2026-08-01T11:30:00Z" },
    { stage_history_id: "sh-3", engagement_id: "eng-meta", to_stage_key: "disqualified", moved_at: "2026-08-01T11:40:00Z" },
    { stage_history_id: "sh-4", engagement_id: "eng-meta", to_stage_key: "unresponsive", moved_at: "2026-08-01T11:41:00Z" },
    { stage_history_id: "sh-5", engagement_id: "eng-organic", to_stage_key: "consultation_booked", moved_at: "2026-08-01T11:42:00Z" },
  ];

  await expectOk("conversions fire on the ruled transitions ONLY — junk and every other stage teach Meta nothing", async () => {
    const candidates = selectConversionCandidates({
      config: s22Config,
      moves: s22Moves,
      facts: s22Facts,
      sentStageHistoryIds: new Set(),
      failedAttempts: new Map(),
      now: s22Now,
    });
    const names = candidates.map((c) => `${c.stage_history_id}:${c.event_name}`).sort();
    if (names.join(",") !== "sh-1:Schedule,sh-2:Purchase") {
      throw new Error(`ruled mapping broken — got ${names.join(",")}`);
    }
  });

  await expectOk("a non-Meta engagement never converts (isolation, ruling 1e)", async () => {
    const candidates = selectConversionCandidates({
      config: s22Config,
      moves: [s22Moves[4]!],
      facts: s22Facts,
      sentStageHistoryIds: new Set(),
      failedAttempts: new Map(),
      now: s22Now,
    });
    if (candidates.length !== 0) throw new Error("an organic-source engagement produced a conversion");
  });

  await expectOk("toggle OFF fires nothing — the default until the founder flips it", async () => {
    const candidates = selectConversionCandidates({
      config: { enabled: false, dataset_id: "1234567890", test_event_code: null },
      moves: s22Moves,
      facts: s22Facts,
      sentStageHistoryIds: new Set(),
      failedAttempts: new Map(),
      now: s22Now,
    });
    if (candidates.length !== 0) throw new Error("a disabled business produced conversions");
    const resolved = resolveConversionsConfig({ meta: {} });
    if (resolved.enabled) throw new Error("an absent conversions block must resolve to OFF");
  });

  await expectOk("hashed fields only — raw email and phone never appear in the payload as sent", async () => {
    const candidates = selectConversionCandidates({
      config: s22Config,
      moves: [s22Moves[0]!],
      facts: s22Facts,
      sentStageHistoryIds: new Set(),
      failedAttempts: new Map(),
      now: s22Now,
    });
    const payload = buildConversionPayload(candidates[0]!, s22Config.test_event_code);
    const json = JSON.stringify(payload);
    if (/ayesha|khan|example\.com|7700|900123/i.test(json)) {
      throw new Error("raw PII leaked into the CAPI payload");
    }
    const userData = payload.data[0]!.user_data;
    if (userData.em?.[0] !== sha256Hex("ayesha.khan@example.com")) {
      throw new Error("email hash is not the SHA-256 of the normalised (trimmed, lowercased) address");
    }
    if (userData.ph?.[0] !== sha256Hex("447700900123")) {
      throw new Error("phone hash is not the SHA-256 of the digits-only E.164 form");
    }
    if (userData.lead_id !== 444455556666777) throw new Error("the leadgen id must ride user_data.lead_id");
    if (payload.test_event_code !== "TEST99") throw new Error("test_event_code must pass through when set");
    if (payload.data[0]!.event_id !== "sh-1") throw new Error("the stage_history id must be the CAPI event_id");
  });

  await expectOk("Purchase carries value ONLY when a money row exists — an amount is never invented", async () => {
    const candidates = selectConversionCandidates({
      config: s22Config,
      moves: [s22Moves[1]!],
      facts: s22Facts,
      sentStageHistoryIds: new Set(),
      failedAttempts: new Map(),
      now: s22Now,
    });
    const withFee = candidates[0]!;
    if (withFee.custom_data.value !== 1500 || withFee.custom_data.currency !== "GBP") {
      throw new Error("the recorded fee (invoice total + currency) must ride custom_data");
    }
    const noFeeFacts = new Map(s22Facts);
    noFeeFacts.set("eng-meta-fee", { ...s22Facts.get("eng-meta-fee")!, invoice: null });
    const bare = selectConversionCandidates({
      config: s22Config,
      moves: [s22Moves[1]!],
      facts: noFeeFacts,
      sentStageHistoryIds: new Set(),
      failedAttempts: new Map(),
      now: s22Now,
    })[0]!;
    if ("value" in bare.custom_data || "currency" in bare.custom_data) {
      throw new Error("a Purchase with no money row must carry NO value field");
    }
  });

  await expectOk("an already-sent stage move never fires twice, and the attempt ceiling retires a failing one", async () => {
    const sent = selectConversionCandidates({
      config: s22Config,
      moves: s22Moves,
      facts: s22Facts,
      sentStageHistoryIds: new Set(["sh-1"]),
      failedAttempts: new Map(),
      now: s22Now,
    });
    if (sent.some((c) => c.stage_history_id === "sh-1")) throw new Error("a sent conversion re-fired");
    const retired = selectConversionCandidates({
      config: s22Config,
      moves: s22Moves,
      facts: s22Facts,
      sentStageHistoryIds: new Set(),
      failedAttempts: new Map([["sh-2", MAX_CONVERSION_ATTEMPTS]]),
      now: s22Now,
    });
    if (retired.some((c) => c.stage_history_id === "sh-2")) {
      throw new Error("a candidate past the attempt ceiling must be retired (its trail is on The Record)");
    }
  });

  await expectOk("a leadgen id that cannot round-trip as a JSON number is omitted, never mangled", async () => {
    const exact = buildConversionUserData({ leadgen_id: "444455556666777", email: null, phone: null });
    if (exact.lead_id !== 444455556666777) throw new Error("a safe leadgen id must be carried");
    const unsafe = buildConversionUserData({ leadgen_id: "99999999999999999999", email: "a@b.com", phone: null });
    if (unsafe.lead_id !== undefined) throw new Error("a precision-unsafe leadgen id must be omitted");
    if (!unsafe.em) throw new Error("matching must still ride the hashed fields");
  });

  await expectOk("the spend pull fails closed naming the missing ads_read scope", async () => {
    const classified = classifyMetaSpendError({
      message: "(#200) Ad account access requires ads_read or ads_management permission",
      type: "OAuthException",
      code: 200,
    });
    if (!classified.missing_scope) throw new Error("a permissions refusal must classify as a scope gap");
    if (!/ads_read/.test(classified.reason)) throw new Error("the skip must NAME the missing scope");
    const other = classifyMetaSpendError({ message: "Unsupported get request", type: "GraphMethodException", code: 100 });
    if (other.missing_scope) throw new Error("an unrelated error must not masquerade as a scope gap");
  });

  // Session 22 (WS2) — billing caps and the priced meter: enforcement lives
  // in the drafting path via these seams; the approval/send doors above run
  // with no budget dependency at all (the structural proof that sends
  // continue — nothing in the SQL pipeline reads a cap).
  console.log("\nSession 22 — billing caps and the priced meter (WS2):");

  await expectOk("the caps resolve from settings.ai_budget — absent, zero or junk means no cap", async () => {
    const none = resolveAiBudget({});
    if (none.soft_cap_gbp !== null || none.hard_cap_gbp !== null) throw new Error("absent caps must be null");
    const junk = resolveAiBudget({ ai_budget: { soft_cap: -5, hard_cap: "ten" } });
    if (junk.soft_cap_gbp !== null || junk.hard_cap_gbp !== null) throw new Error("junk caps must be null");
    const set = resolveAiBudget({ ai_budget: { soft_cap: 5, hard_cap: 20 } });
    if (set.soft_cap_gbp !== 5 || set.hard_cap_gbp !== 20) throw new Error("set caps must read back");
  });

  await expectError(
    "the hard cap refuses generation VISIBLY, naming the cap — the s15 permanent-failure lane",
    /hard cap.*£1\.00.*generation refuses/i,
    async () => {
      guardGenerationBudget(1.02, { soft_cap_gbp: null, hard_cap_gbp: 1 });
    }
  );

  await expectOk("under the hard cap (or with only a soft cap) generation proceeds — soft NEVER throws", async () => {
    guardGenerationBudget(0.99, { soft_cap_gbp: null, hard_cap_gbp: 1 });
    guardGenerationBudget(999, { soft_cap_gbp: 5, hard_cap_gbp: null });
    guardGenerationBudget(999, { soft_cap_gbp: null, hard_cap_gbp: null });
  });

  await expectOk("the hard-cap refusal is the s15 lane's PermanentGenerationError (never a silent stub)", async () => {
    try {
      guardGenerationBudget(2, { soft_cap_gbp: null, hard_cap_gbp: 1 });
      throw new Error("no refusal was raised");
    } catch (err) {
      if (!(err instanceof PermanentGenerationError)) {
        throw new Error("the refusal must ride the permanent-failure lane so the step fails visibly");
      }
      if (!/template-path drafts continue|sends.*continue/i.test((err as Error).message)) {
        throw new Error("the refusal must state that non-generative work continues");
      }
    }
  });

  await expectOk("the soft cap banners without blocking — crossing detected exactly once", async () => {
    const budget = { soft_cap_gbp: 5, hard_cap_gbp: null };
    if (!softCapJustCrossed(4.9, 5.1, budget)) throw new Error("the crossing must be detected");
    if (softCapJustCrossed(3, 4, budget)) throw new Error("no crossing below the cap");
    if (softCapJustCrossed(5.2, 6, budget)) throw new Error("an already-crossed month must not re-fire");
    if (softCapJustCrossed(1, 9, { soft_cap_gbp: null, hard_cap_gbp: null })) {
      throw new Error("no soft cap means no crossing");
    }
    const assessed = evaluateAiBudget(5.1, budget);
    if (!assessed.soft_crossed || assessed.hard_crossed) {
      throw new Error("a soft crossing must never read as a hard stop");
    }
  });

  await expectOk("the meter prices at list rates with the recorded fx — an unknown model stays unpriced", async () => {
    const floor = priceGeneration({ model: LIGHT_MODEL_FLOOR.model, input_tokens: 1_000_000, output_tokens: 0 });
    if (!floor || floor.amount_usd !== 1 || floor.amount_gbp !== Math.round(1 * USD_TO_GBP_RATE * 1e6) / 1e6) {
      throw new Error("floor input pricing must be the list rate times the recorded fx");
    }
    const cached = priceGeneration({
      model: LIGHT_MODEL_FLOOR.model,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 1_000_000,
    });
    if (!cached || cached.amount_usd !== 0.1) throw new Error("cache reads price at the cache-read rate");
    if (priceGeneration({ model: "some-future-model", input_tokens: 1000, output_tokens: 10 }) !== null) {
      throw new Error("an unknown model must stay unpriced, never guessed");
    }
    if (pricedAmountGbp({ provider: "anthropic", model: LIGHT_MODEL_FLOOR.model, tokens: 1200 }) !== null) {
      throw new Error("a pre-meter cost block must read as unpriced, never retro-priced");
    }
    if (pricedAmountGbp({ amount_gbp: 0.02 }) !== 0.02) throw new Error("a priced line must read back");
  });

  // Session 22 (WS3) — the Light performance tile: the numbers agree with a
  // constructed fixture's known truth (the ordered smoke), and empty weeks
  // claim nothing.
  console.log("\nSession 22 — the Light performance tile (WS3):");

  await expectOk("the tile's numbers agree with a constructed fixture's known truth", async () => {
    const perf = computeLightPerformance({
      drafts_generated: 10,
      stamped: 8,
      rejected: 2,
      edit_signals: 2,
      compliance_refusals: 1,
      cost_blocks: [
        { tokens: 1000, amount_gbp: 0.01 },
        { tokens: 2000, amount_gbp: 0.02 },
        { tokens: 3000 }, // a pre-meter line: tokens counted, spend unpriced
      ],
    });
    if (perf.approval_rate_pct !== 80) throw new Error(`approval rate: expected 80, got ${perf.approval_rate_pct}`);
    if (perf.edit_rate_pct !== 25) throw new Error(`edit rate: expected 25, got ${perf.edit_rate_pct}`);
    if (perf.mean_tokens !== 2000) throw new Error(`mean tokens: expected 2000, got ${perf.mean_tokens}`);
    if (perf.spend_gbp !== 0.03) throw new Error(`spend: expected 0.03, got ${perf.spend_gbp}`);
    if (perf.unpriced_lines !== 1) throw new Error("the pre-meter line must be counted, never priced");
    if (perf.compliance_refusals !== 1 || perf.drafts_generated !== 10) throw new Error("counts must pass through");
  });

  await expectOk("an empty week claims no rate — honest empty states, never an invented number", async () => {
    const perf = computeLightPerformance({
      drafts_generated: 0,
      stamped: 0,
      rejected: 0,
      edit_signals: 0,
      compliance_refusals: 0,
      cost_blocks: [],
    });
    if (perf.approval_rate_pct !== null || perf.edit_rate_pct !== null || perf.mean_tokens !== null) {
      throw new Error("an empty week must render dashes, not rates");
    }
    if (perf.spend_gbp !== 0) throw new Error("an empty week's spend is zero");
  });

  await expectOk("the week window is Monday-started UTC and seven days wide", async () => {
    const midWeek = weekWindowUtc(new Date("2026-08-01T12:00:00Z")); // a Saturday
    if (midWeek.start !== "2026-07-27T00:00:00.000Z") throw new Error(`start: ${midWeek.start}`);
    if (midWeek.end !== "2026-08-03T00:00:00.000Z") throw new Error(`end: ${midWeek.end}`);
    const onMonday = weekWindowUtc(new Date("2026-07-27T00:30:00Z"));
    if (onMonday.start !== "2026-07-27T00:00:00.000Z") throw new Error("a Monday belongs to its own week");
  });

  // Session 22 (WS5) — the read-layer diet: the window policy and the
  // founder-ruled counts law (5e), with the inbox query's bound PINNED by a
  // file tripwire (the s20 bodySizeLimit precedent).
  console.log("\nSession 22 — the read-layer diet (WS5):");

  await expectOk("the page-size policy clamps every request into the ruled selector (10/20/50, default 20)", async () => {
    if (clampPageSize(undefined) !== DEFAULT_PAGE_SIZE) throw new Error("no size means the default");
    if (clampPageSize(50) !== 50 || clampPageSize(10) !== 10) throw new Error("selector sizes must pass");
    if (clampPageSize(5000) !== DEFAULT_PAGE_SIZE) throw new Error("an off-selector size must clamp to the default");
    if (clampPage(-3) !== 1 || clampPage(undefined) !== 1) throw new Error("page floors at 1");
    const range = pageRange(3, 20);
    if (range.from !== 40 || range.to !== 59) throw new Error(`page 3 of 20 must be rows 40..59, got ${range.from}..${range.to}`);
    const capped = pageRange(1, 9999);
    if (capped.to - capped.from + 1 > MAX_LIST_WINDOW) {
      throw new Error("no window may ever exceed MAX_LIST_WINDOW, whatever the caller asks");
    }
  });

  await expectOk("the inbox query's bound is pinned — the paginated read calls .range() and the unbounded read is gone", async () => {
    // cwd is packages/db (the workspace script), matching the migrations read.
    const queriesSource = readFileSync(resolve("../../apps/web/lib/server/queries.ts"), "utf8");
    const inboxPage = queriesSource.slice(queriesSource.indexOf("export async function getInboxPage"));
    const inboxPageBody = inboxPage.slice(0, inboxPage.indexOf("\n}\n"));
    if (!inboxPageBody.includes(".range(range.from, range.to)")) {
      throw new Error("getInboxPage no longer windows its approval_inbox read — the 5a bound is broken");
    }
    if (!/clampPageSize|pageRange/.test(inboxPageBody)) {
      throw new Error("getInboxPage no longer clamps through the read policy");
    }
    if (/export async function getInbox\(\)/.test(queriesSource)) {
      throw new Error("the unbounded getInbox() read has returned — the diet forbids it");
    }
  });

  await expectOk("the counts law (5e): sidebar and dashboard counts come from COUNT aggregates, never fetched rows", async () => {
    const queriesSource = readFileSync(resolve("../../apps/web/lib/server/queries.ts"), "utf8");
    for (const fn of ["getInboxCount", "getOpenTaskCount", "getInboxSummary"]) {
      const start = queriesSource.indexOf(`export async function ${fn}`);
      if (start < 0) throw new Error(`${fn} is missing`);
      const body = queriesSource.slice(start, start + 2200);
      if (!body.includes(`count: "exact", head: true`)) {
        throw new Error(`${fn} must count with a head COUNT aggregate`);
      }
    }
  });

  // Session 23 (WS1) — the approval gate's information integrity: thread
  // unread derives in the database (0035), and cap semantics are proven RAW
  // (1d — the founder's failed DoD was display rounding, not the comparison).
  console.log("\nSession 23 — approval gate information integrity (WS1):");

  await expectOk("thread unread derives in the database: inbound sets it, opening clears it, a newer inbound sets it again (0035)", async () => {
    const c = await db.query<{ id: string }>(
      `insert into public.contacts (business_id, created_by, type, display_name)
       values ($1, $2, 'person', 'Unread Smoke Contact') returning id`,
      [f.business_id, f.agent_id]
    );
    const t = await db.query<{ id: string }>(
      `insert into public.comm_threads (business_id, created_by, contact_id, channel)
       values ($1, $2, $3, 'email') returning id`,
      [f.business_id, f.agent_id, c.rows[0]!.id]
    );
    const threadId = t.rows[0]!.id;
    const unread = async () =>
      (
        await db.query<{ is_unread: boolean }>(
          `select is_unread from public.comm_threads where id = $1`,
          [threadId]
        )
      ).rows[0]!.is_unread;
    if (await unread()) throw new Error("a thread with no inbound must not be unread");
    await db.query(
      `update public.comm_threads set last_inbound_at = '2026-08-01T10:00:00Z' where id = $1`,
      [threadId]
    );
    if (!(await unread())) throw new Error("an inbound must set unread");
    await db.query(
      `update public.comm_threads set last_opened_at = '2026-08-01T10:05:00Z' where id = $1`,
      [threadId]
    );
    if (await unread()) throw new Error("opening the thread must clear unread");
    await db.query(
      `update public.comm_threads set last_inbound_at = '2026-08-01T10:10:00Z' where id = $1`,
      [threadId]
    );
    if (!(await unread())) throw new Error("a newer inbound must set unread again");
  });

  await expectOk("cap crossings compare RAW metered amounts — £0.006 against a £0.01 cap crosses nothing (1d)", async () => {
    const budget = { soft_cap_gbp: null, hard_cap_gbp: 0.01 };
    const under = evaluateAiBudget(0.006, budget);
    if (under.hard_crossed) {
      throw new Error("0.006 must not cross a 0.01 cap — the comparison is raw, never display-rounded");
    }
    guardGenerationBudget(0.006, budget); // must not throw
    if (!evaluateAiBudget(0.01, budget).hard_crossed) {
      throw new Error("reaching the cap exactly must cross");
    }
    let refused = false;
    try {
      guardGenerationBudget(0.0101, budget);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error("no refusal at 0.0101 against a 0.01 cap");
  });

  await expectOk("the Conversations reads are windowed (5c) — the thread list pages, the tail is bounded, the unbounded read is gone", async () => {
    // File tripwire (the s20/s22 precedent): the 5c ruling's shape is pinned
    // so a later edit cannot quietly return to fetch-everything.
    const queriesSource = readFileSync(resolve("../../apps/web/lib/server/queries.ts"), "utf8");
    if (/export async function getConversations\(\)/.test(queriesSource)) {
      throw new Error("the unbounded getConversations() read has returned — 5c forbids it");
    }
    const listStart = queriesSource.indexOf("export async function getConversationList");
    if (listStart < 0) throw new Error("getConversationList is missing");
    const listBody = queriesSource.slice(listStart, listStart + 3000);
    if (!listBody.includes(".range(range.from, range.to)")) {
      throw new Error("the thread list no longer windows its read");
    }
    if (!listBody.includes(`count: "exact"`)) {
      throw new Error("the thread list total must be a COUNT aggregate (5e)");
    }
    const windowStart = queriesSource.indexOf("async function readThreadWindow");
    if (windowStart < 0) throw new Error("readThreadWindow is missing");
    const windowBody = queriesSource.slice(windowStart, windowStart + 2200);
    if (!windowBody.includes(".limit(THREAD_TAIL_WINDOW + 1)")) {
      throw new Error("the thread tail no longer limits by THREAD_TAIL_WINDOW — the 5c bound is broken");
    }
  });

  await expectOk("The Record reads day-anchored bounded windows (5b) — the 300-row block is gone and the cursor window is pinned", async () => {
    const queriesSource = readFileSync(resolve("../../apps/web/lib/server/queries.ts"), "utf8");
    const start = queriesSource.indexOf("export async function getRecordEvents");
    if (start < 0) throw new Error("getRecordEvents is missing");
    const body = queriesSource.slice(start, start + 3000);
    if (!body.includes(".limit(RECORD_WINDOW + 1)")) {
      throw new Error("getRecordEvents no longer windows by RECORD_WINDOW — the 5b bound is broken");
    }
    if (/\.limit\(300\)/.test(body)) {
      throw new Error("the 300-row block has returned — 5b replaced it with cursor windows");
    }
  });

  await expectOk("sub-penny display shows real precision — the display can never contradict the comparison (1d)", async () => {
    if (formatMeteredGbp(0.006) !== "£0.006") throw new Error(`0.006 → ${formatMeteredGbp(0.006)}`);
    if (formatMeteredGbp(0.01) !== "£0.01") throw new Error(`0.01 → ${formatMeteredGbp(0.01)}`);
    if (formatMeteredGbp(0) !== "£0.00") throw new Error(`0 → ${formatMeteredGbp(0)}`);
    if (formatMeteredGbp(0.0004) !== "£0.0004") throw new Error(`0.0004 → ${formatMeteredGbp(0.0004)}`);
    if (formatMeteredGbp(12.5) !== "£12.50") throw new Error(`12.5 → ${formatMeteredGbp(12.5)}`);
    if (formatMeteredGbp(150) !== "£150") throw new Error(`150 → ${formatMeteredGbp(150)}`);
  });

  // Session 23 (WS4d) — task cancellation: terminal in the database, and the
  // request lands in the approval_inbox as its own arm.
  console.log("\nSession 23 — task cancellation (WS4d):");

  const cancelTask = await db.query<{ id: string }>(
    `insert into public.tasks (business_id, created_by, assignee_actor_id, title, status)
     values ($1, $2, $2, 'Cancellation smoke task', 'open') returning id`,
    [f.business_id, f.human_id]
  );
  const cancelTaskId = cancelTask.rows[0]!.id;

  await expectOk("a cancellation request surfaces in the approval_inbox as its own arm, dated by the request", async () => {
    await db.query(
      `update public.tasks
          set attributes = attributes || '{"cancellation_request": {"requested_by": "${f.human_id}", "requested_at": "2026-08-02T09:00:00Z", "reason": "no longer needed"}}'::jsonb
        where id = $1`,
      [cancelTaskId]
    );
    const rows = await db.query<{ item_type: string; preview: string; awaiting_since: string }>(
      `select item_type, preview, awaiting_since from public.approval_inbox where item_id = $1 and item_type = 'task_cancellation'`,
      [cancelTaskId]
    );
    if (rows.rows.length !== 1) throw new Error("the request did not surface as task_cancellation");
    if (rows.rows[0]!.preview !== "no longer needed") throw new Error("the preview must carry the stated reason");
    if (!new Date(rows.rows[0]!.awaiting_since).toISOString().startsWith("2026-08-02")) {
      throw new Error("awaiting_since must be the request's own clock");
    }
  });

  await expectError(
    "a cancelled task is terminal — no write path may reopen it (0037)",
    /terminal|cannot leave/i,
    async () => {
      await db.query(`update public.tasks set status = 'cancelled' where id = $1`, [cancelTaskId]);
      await db.query(`update public.tasks set status = 'open' where id = $1`, [cancelTaskId]);
    }
  );

  await expectOk("a closed task's stale request never haunts the inbox — the arm reads live tasks only", async () => {
    const rows = await db.query(
      `select 1 from public.approval_inbox where item_id = $1 and item_type = 'task_cancellation'`,
      [cancelTaskId]
    );
    if (rows.rows.length !== 0) {
      throw new Error("a cancelled task's request still shows as a stamp owed");
    }
  });

  // Session 23 (WS5c) — stored object names carry a human slug prefix.
  await expectOk("storage object names are eye-findable — a human slug prefixes the uuid (5c)", async () => {
    if (storageSlug("Spouse Visa Guide (v2).pdf") !== "spouse-visa-guide-v2") {
      throw new Error(`slug: ${storageSlug("Spouse Visa Guide (v2).pdf")}`);
    }
    if (storageSlug("....pdf") !== "file") throw new Error("a nameless file must still slug to something");
    if (storageSlug(`${"a".repeat(90)}.pdf`).length > 60) throw new Error("slugs are bounded");
  });

  // Session 23 — PRIORITY FIX (founder-ordered, blocks the s22 DoD (1)):
  // the conversions stage lookup filtered stage_definitions by a business_id
  // column that DOES NOT EXIST — and the s22 smoke never caught it because
  // its fixture built a convenient world. These smokes ground the resolution
  // in the schema's real shape: stages seeded exactly as the v3 installer
  // writes them (engagement_type-scoped, sort_order), read with the sweep's
  // own column list, resolved through the engagement's type.
  console.log("\nSession 23 — the conversions stage resolution (priority fix):");

  await expectOk("the ruled mapping resolves against a v3-installer-shaped seed — engagement_type-scoped stages, sort_order and all", async () => {
    // Seed EXACTLY the installer's shape (0003 schema: engagement_type_id,
    // key, label, sort_order; no business_id column exists to lean on).
    const seeded = await db.query<{ id: string; key: string }>(
      `insert into public.stage_definitions (engagement_type_id, key, label, sort_order)
       values ($1, 'consultation_booked', 'Consultation booked', 50),
              ($1, 'instructed', 'Instructed', 60)
       returning id, key`,
      [f.type_id]
    );
    const idByKey = new Map(seeded.rows.map((s) => [s.key, s.id]));

    // Read back with the sweep's OWN column list and filters.
    const stageRows = await db.query<{ id: string; key: string; engagement_type_id: string }>(
      `select id, key, engagement_type_id from public.stage_definitions
        where key in ('consultation_booked', 'instructed') and archived_at is null`
    );
    const moves = resolveRuledMoves({
      stageRows: stageRows.rows,
      engagementTypes: new Map([["eng-a", f.type_id]]),
      history: [
        { id: "sh-a", engagement_id: "eng-a", to_stage: idByKey.get("consultation_booked")!, moved_at: "2026-08-02T10:00:00Z" },
        { id: "sh-b", engagement_id: "eng-a", to_stage: idByKey.get("instructed")!, moved_at: "2026-08-02T11:00:00Z" },
      ],
    });
    const keys = moves.map((m) => `${m.stage_history_id}:${m.to_stage_key}`).sort().join(",");
    if (keys !== "sh-a:consultation_booked,sh-b:instructed") {
      throw new Error(`resolution against the real shape failed — got ${keys || "nothing"}`);
    }
  });

  await expectOk("a same-key stage on ANOTHER engagement type never resolves for this engagement (type isolation)", async () => {
    const otherType = await db.query<{ id: string }>(
      `insert into public.engagement_types (template_id, key, label)
       values ($1, 'matter_smoke', 'Matter (smoke)') returning id`,
      [f.template_id]
    );
    const foreignStage = await db.query<{ id: string }>(
      `insert into public.stage_definitions (engagement_type_id, key, label, sort_order)
       values ($1, 'consultation_booked', 'Consultation booked', 50) returning id`,
      [otherType.rows[0]!.id]
    );
    const stageRows = await db.query<{ id: string; key: string; engagement_type_id: string }>(
      `select id, key, engagement_type_id from public.stage_definitions
        where key in ('consultation_booked', 'instructed') and archived_at is null`
    );
    const moves = resolveRuledMoves({
      stageRows: stageRows.rows,
      engagementTypes: new Map([["eng-a", f.type_id]]),
      history: [
        { id: "sh-x", engagement_id: "eng-a", to_stage: foreignStage.rows[0]!.id, moved_at: "2026-08-02T12:00:00Z" },
      ],
    });
    if (moves.length !== 0) {
      throw new Error("a foreign type's stage resolved — the engagement's own type must decide");
    }
  });

  await expectOk("no stage_definitions read anywhere pairs with a business_id filter — the phantom column is fenced off", async () => {
    // File tripwire (the founder's 'fixtures mirror the installer's real
    // shapes' order made structural): the wrong lookup cannot quietly return.
    for (const file of ["../src/conversions.ts", "../scripts/circuit-conversion.ts"]) {
      const source = readFileSync(resolve(import.meta.dirname, file), "utf8");
      let at = source.indexOf(`from("stage_definitions")`);
      while (at >= 0) {
        const slice = source.slice(at, at + 320);
        if (slice.includes(`.eq("business_id"`)) {
          throw new Error(`${file}: a stage_definitions read filters by business_id — the column does not exist`);
        }
        at = source.indexOf(`from("stage_definitions")`, at + 1);
      }
    }
  });

  // Session 23 (WS6) — trigger consumption per workflow KEY + the activation
  // frontier (founder-ruled after the 116-burst; 0038).
  console.log("\nSession 23 — trigger consumption per workflow key (WS6):");

  // A key with two versions, one consumed trigger, and a bystander lead.
  const s23EngA = await db.query<{ id: string }>(
    `insert into public.engagements (business_id, created_by, template_type_id, title, stage_id, owner_actor_id)
     values ($1, $2, $3, 'WS6 lead A', $4, $5) returning id`,
    [f.business_id, f.agent_id, f.type_id, f.stage_id, f.human_id]
  );
  const s23EngB = await db.query<{ id: string }>(
    `insert into public.engagements (business_id, created_by, template_type_id, title, stage_id, owner_actor_id)
     values ($1, $2, $3, 'WS6 lead B', $4, $5) returning id`,
    [f.business_id, f.agent_id, f.type_id, f.stage_id, f.human_id]
  );
  const s23Evt = await db.query<{ id: string }>(
    `insert into public.events (business_id, actor_id, action, entity_type, entity_id, occurred_at)
     values ($1, $2, 'engagement.created', 'engagement', $3, '2026-08-01T10:00:00Z') returning id`,
    [f.business_id, f.agent_id, s23EngA.rows[0]!.id]
  );
  const s23EvtId = s23Evt.rows[0]!.id;

  async function s23MakeActiveDefinition(version: number): Promise<string> {
    const def = await db.query<{ id: string }>(
      `insert into public.workflow_definitions (business_id, created_by, key, version, template_id, trigger, status, description_plain)
       values ($1, $2, 'wf_s23_consumption', $3, $4, '{"action":"engagement.created"}'::jsonb, 'draft',
               'WS6 consumption smoke definition.') returning id`,
      [f.business_id, f.human_id, version, f.template_id]
    );
    await db.query(
      `insert into public.workflow_steps (business_id, created_by, definition_id, key, sort_order, kind, config)
       values ($1, $2, $3, 'wait_step', 1, 'wait', '{"wait":{"days":1}}'::jsonb)`,
      [f.business_id, f.human_id, def.rows[0]!.id]
    );
    await db.query(`select public.submit_workflow_definition($1, $2)`, [def.rows[0]!.id, f.human_id]);
    await db.query(`select public.approve_workflow_definition($1, $2)`, [def.rows[0]!.id, f.human_id]);
    return def.rows[0]!.id;
  }

  const s23V1 = await s23MakeActiveDefinition(1);
  await expectOk("a triggered start CLAIMS its event for the KEY (0038 — the claim rides the run's own transaction)", async () => {
    await db.query(`select public.start_workflow_run($1, $2, $3, $4)`, [
      s23V1,
      s23EngA.rows[0]!.id,
      f.agent_id,
      s23EvtId,
    ]);
    const claims = await db.query<{ n: number }>(
      `select count(*)::int as n from public.workflow_trigger_consumptions
        where business_id = $1 and workflow_key = 'wf_s23_consumption' and trigger_event_id = $2`,
      [f.business_id, s23EvtId]
    );
    if (claims.rows[0]!.n !== 1) throw new Error("the claim row did not land with the run");
  });

  const s23V2 = await s23MakeActiveDefinition(2);

  await expectError(
    "a re-issued definition consumes nothing its predecessor consumed",
    /workflow_trigger_consumptions|duplicate key/,
    () =>
      db.query(`select public.start_workflow_run($1, $2, $3, $4)`, [
        s23V2,
        s23EngB.rows[0]!.id,
        f.agent_id,
        s23EvtId,
      ])
  );

  await expectOk("the refused replay left NOTHING behind — no run, no orphan claim (one transaction)", async () => {
    const runs = await db.query<{ n: number }>(
      `select count(*)::int as n from public.workflow_runs where definition_id = $1`,
      [s23V2]
    );
    if (runs.rows[0]!.n !== 0) throw new Error("a replay run row survived the refused claim");
    const claims = await db.query<{ n: number }>(
      `select count(*)::int as n from public.workflow_trigger_consumptions
        where business_id = $1 and workflow_key = 'wf_s23_consumption'`,
      [f.business_id]
    );
    if (claims.rows[0]!.n !== 1) throw new Error("the key must hold exactly one claim for the event");
  });

  await expectOk("activation starts no runs for pre-existing engagements", async () => {
    // The gated activation stamped the re-issue's frontier at the KEY's
    // consumption frontier — the predecessor's newest consumed arrival —
    // so the scan (pinned below) only reads arrivals after it.
    const frontier = await db.query<{ trigger_frontier_at: string | null }>(
      `select trigger_frontier_at from public.workflow_definitions where id = $1`,
      [s23V2]
    );
    const at = frontier.rows[0]!.trigger_frontier_at;
    if (!at) throw new Error("the re-issue's activation stamped no frontier");
    if (!new Date(at).toISOString().startsWith("2026-08-01T10:00:00")) {
      throw new Error(`the frontier must be the predecessor's consumption frontier — got ${at}`);
    }
    const v1Frontier = await db.query<{ trigger_frontier_at: string | null }>(
      `select trigger_frontier_at from public.workflow_definitions where id = $1`,
      [s23V1]
    );
    if (v1Frontier.rows[0]!.trigger_frontier_at !== null) {
      throw new Error("a first version (no predecessor) must keep a null frontier — fresh-tenant behaviour unchanged");
    }
    // File tripwire: the scan consumes by KEY and honours the frontier.
    const workflowSource = readFileSync(resolve(import.meta.dirname, "../src/workflow.ts"), "utf8");
    if (!workflowSource.includes(`from("workflow_trigger_consumptions")`)) {
      throw new Error("the tick's consumed lookup no longer reads the key-scoped claims");
    }
    if (!workflowSource.includes("trigger_frontier_at")) {
      throw new Error("the tick's trigger scan no longer honours the activation frontier");
    }
  });

  // Hotfix (2 Aug 2026) — Graph inbound processing silently dead: the s20
  // reference match packed jsonb containments into a PostgREST `or=` string
  // (PGRST100, unparsable — proven against production), the duplicate-claim
  // branch advanced the cursor past claimed-but-unprocessed rows, and the
  // poll's errors died in a JSON response nobody reads. PGlite cannot speak
  // PostgREST, so the syntax class is fenced by file tripwires (the s20/s22
  // precedent) and the time law by the pure cutoff.
  console.log("\nHotfix — graph inbound processor (2 Aug 2026):");

  await expectOk("the stale-claim window rides timeScale() — a claim is stale only past the SCALED cutoff", async () => {
    const now = new Date("2026-08-02T16:00:00.000Z");
    const expected = new Date(now.getTime() - scaleDurationMs(MAIL_CLAIM_STALE_AFTER_MS)).toISOString();
    if (mailClaimStaleCutoffIso(now) !== expected) {
      throw new Error(`cutoff ${mailClaimStaleCutoffIso(now)} does not ride scaleDurationMs (expected ${expected})`);
    }
    const justInside = new Date(now.getTime() - scaleDurationMs(MAIL_CLAIM_STALE_AFTER_MS) + 1000).toISOString();
    if (!(justInside > mailClaimStaleCutoffIso(now))) {
      throw new Error("a claim younger than the scaled window counted as stale");
    }
  });

  await expectOk("the reference match reads jsonb containment, never a PostgREST or= logic tree (the PGRST100 fence)", async () => {
    // File tripwire (the s20/s22 precedent): embedded JSON can never parse
    // inside `or=` — PostgREST splits conditions on the commas the JSON is
    // made of. The defect shipped green because PGlite never parses
    // PostgREST syntax; this fence is the local guard for that class.
    const source = readFileSync(resolve(import.meta.dirname, "../src/inbound.ts"), "utf8");
    if (/\.or\([^)]*external_refs/s.test(source)) {
      throw new Error("inbound.ts packs external_refs containment into an or= string again — PGRST100 in production");
    }
    if (!source.includes(`.contains("external_refs"`)) {
      throw new Error("the reference match no longer uses the parseable .contains form");
    }
  });

  await expectOk("a duplicate claim is not proof of completed work — the branch reads processed_at and the sweep is wired", async () => {
    // File tripwire: the three legs of the hotfix stay standing — (a) the
    // duplicate-claim branch distinguishes replay from claimed-but-dead,
    // (b) claim stamps are error-checked, (c) the fail-closed stale sweep
    // runs and its visible-failure kind exists in the declared vocabulary.
    const source = readFileSync(resolve(import.meta.dirname, "../src/inbound.ts"), "utf8");
    for (const marker of ['"claim read"', '"claim stamp"', "sweepStaleMailClaims(db, binding, reader, cfg, report, now)", '"stale claim stamp"']) {
      if (!source.includes(marker)) throw new Error(`the hotfix marker ${marker} is gone from inbound.ts`);
    }
    const kinds = readFileSync(resolve(import.meta.dirname, "../src/event-kinds.ts"), "utf8");
    if (!kinds.includes(`"inbound.mail_claim_stale"`)) {
      throw new Error("the stale-claim visible-failure kind left the declared vocabulary");
    }
  });

  // Defect trio (2 Aug 2026, founder-observed) — right behaviour, invisible
  // or unconfigurable: the live inbox's silent-death class, quiet-hours
  // legibility + the SEND NOW override (0039), and business hours going real
  // as the ONE config display and enforcement both read.
  console.log("\nDefect trio — live inbox, quiet-hours legibility, business hours (2 Aug 2026):");

  await expectOk("the live inbox rings for a draft ENTERING pending and for inbound arrivals — and only those", async () => {
    // The defect's exact row shape: Realtime's old record carries only the
    // PK (REPLICA IDENTITY default), so prev.status is absent — the arrival
    // must still ring.
    if (!classifyCommChange("UPDATE", { status: "pending_approval" }, {}).tone) {
      throw new Error("a draft entering pending with a PK-only old record did not ring — the badge defect's shape");
    }
    if (!classifyCommChange("INSERT", { status: "pending_approval", direction: "outbound" }, null).tone) {
      throw new Error("a draft born pending did not ring");
    }
    if (!classifyCommChange("INSERT", { direction: "inbound" }, null).tone) {
      throw new Error("an inbound arrival did not ring (WS1c)");
    }
    if (classifyCommChange("UPDATE", { status: "pending_approval" }, { status: "pending_approval" }).tone) {
      throw new Error("an edit to an already-pending draft rang — edits are not arrivals");
    }
    if (classifyCommChange("UPDATE", { status: "sent", direction: "outbound" }, {}).tone) {
      throw new Error("a decision rang the doorbell");
    }
  });

  await expectOk("a dead channel is rejoined, never trusted — and the component keeps auth on the socket", async () => {
    for (const dead of ["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"]) {
      if (!shouldRejoin(dead)) throw new Error(`${dead} did not demand a rejoin`);
    }
    if (shouldRejoin("SUBSCRIBED")) throw new Error("a healthy channel was torn down");
    if (rejoinDelayMs(0) !== 1000 || rejoinDelayMs(10) !== 30_000) {
      throw new Error("the rejoin backoff lost its shape (1s start, 30s cap)");
    }
    // File tripwire (the live-inbox smoke, founder-ordered): the lifecycle
    // legs stay standing — auth on the socket BEFORE the join, the join
    // status WATCHED with the rejoin rules, a reconciling refresh on
    // (re)join and on returning to the tab, fresh tokens re-armed.
    const source = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/components/shell/live-inbox.tsx"),
      "utf8"
    );
    for (const marker of [
      "db.realtime.setAuth",
      ".subscribe((status)",
      "shouldRejoin(status)",
      "classifyCommChange(",
      "onAuthStateChange",
      "visibilitychange",
    ]) {
      if (!source.includes(marker)) throw new Error(`live-inbox.tsx lost its lifecycle leg: ${marker}`);
    }
  });

  await expectOk("business hours are ONE source — the editor's save, the hold and the display cannot disagree", async () => {
    // The editor saves a send window; the hold reads settings.quiet_hours.
    // Round-trip both conversions and then prove the hold against the saved
    // shape — display and dispatch_at derive from the same config.
    const window = { open: "09:00", close: "17:30" };
    const quiet = quietHoursFromSendWindow(window);
    if (quiet.start !== "17:30" || quiet.end !== "09:00") throw new Error("save mapped the window wrongly");
    const back = sendWindowFromQuietHours(quiet);
    if (back.open !== window.open || back.close !== window.close) {
      throw new Error("the conversions are not inverses — display could drift from enforcement");
    }
    const saved = { quiet_hours: quiet } as Record<string, unknown>;
    const resolved = resolveQuietHours(saved);
    if (!resolved || resolved.start !== "17:30") throw new Error("the hold does not read the saved config");
    // 22:00 London is inside the held window; dispatch at 09:00 next day.
    const held = quietHoursHoldUntil(new Date("2026-08-02T21:00:00.000Z"), "Europe/London", resolved);
    if (!held) throw new Error("a 22:00 stamp was not held by the saved hours");
    if (minutesOfDayInLondon(held) !== 9 * 60) {
      throw new Error(`held dispatch is not the window's open — got ${held.toISOString()}`);
    }
    if (describeSendWindow(window, "Europe/London") !== "09:00–17:30 · Europe/London") {
      throw new Error("the derived business_hours display string changed shape");
    }
  });

  await expectOk("the default window is stated as a default — 'not yet set by you' until the firm sets it", async () => {
    if (isQuietHoursSet(undefined) || isQuietHoursSet({}) || isQuietHoursSet({ quiet_hours: "20:00" })) {
      throw new Error("an unset or malformed config read as firm-set");
    }
    if (!isQuietHoursSet({ quiet_hours: { start: "20:00", end: "08:00" } })) {
      throw new Error("a firm-set window read as default");
    }
    if (!isQuietHoursSet({ quiet_hours: null })) {
      throw new Error("a deliberate disable read as 'not yet set'");
    }
    const fallback = resolveQuietHours({});
    if (fallback?.start !== QUIET_HOURS_DEFAULT.start || fallback?.end !== QUIET_HOURS_DEFAULT.end) {
      throw new Error("the unset fallback is no longer the shipped default");
    }
  });

  // --- 0039: the quiet-hours SEND NOW override -----------------------------
  const trioContact = await db.query<{ id: string }>(
    `insert into public.contacts (business_id, created_by, type, display_name, status)
     values ($1, $2, 'person', 'Held Client', 'active') returning id`,
    [activation!.business_id, activation!.owner_actor_id]
  );
  await db.query(
    `insert into public.contact_channels (business_id, created_by, contact_id, channel, value, is_primary, consent)
     values ($1, $2, $3, 'email', 'held@client.test', true, '{"transactional": true}'::jsonb)`,
    [activation!.business_id, activation!.owner_actor_id, trioContact.rows[0]!.id]
  );
  const trioHeldComm = async (): Promise<string> => {
    // A HUMAN-authored draft (compliance-exempt, decision 21), submitted and
    // stamped through the real doors, then held as the dispatcher holds it.
    const t = await db.query<{ id: string }>(
      `insert into public.comm_threads (business_id, created_by, contact_id, channel)
       values ($1, $2, $3, 'email') returning id`,
      [activation!.business_id, activation!.owner_actor_id, trioContact.rows[0]!.id]
    );
    const r = await db.query<{ id: string }>(
      `insert into public.communications (business_id, created_by, thread_id, contact_id, channel, direction, status, body)
       values ($1, $2, $3, $4, 'email', 'outbound', 'draft', 'A perfectly good answer, stamped at night.') returning id`,
      [activation!.business_id, activation!.owner_actor_id, t.rows[0]!.id, trioContact.rows[0]!.id]
    );
    await db.query(`select public.submit_communication($1, $2)`, [r.rows[0]!.id, activation!.owner_actor_id]);
    await db.query(`select public.approve_communication($1, $2)`, [r.rows[0]!.id, activation!.owner_actor_id]);
    await db.query(`update public.communications set scheduled_for = now() + interval '9 hours' where id = $1`, [
      r.rows[0]!.id,
    ]);
    return r.rows[0]!.id;
  };

  await expectError(
    "the SEND NOW override is a HUMAN act — an agent actor is refused by the database",
    /HUMAN act/,
    async () => {
      const id = await trioHeldComm();
      await db.query(`select public.override_quiet_hours_hold($1, $2)`, [id, activation!.light_actor_id]);
    }
  );

  await expectError(
    "a human WITHOUT stamp authority cannot send now — approvals.comms (execute) or the owner, nobody else",
    /approvals\.comms/,
    async () => {
      const account = await db.query<{ account_id: string }>(
        `select account_id from public.businesses where id = $1`,
        [activation!.business_id]
      );
      const bystander = await db.query<{ id: string }>(
        `insert into public.actors (account_id, actor_type, display_name)
         values ($1, 'human', 'Ungranted Human') returning id`,
        [account.rows[0]!.account_id]
      );
      const id = await trioHeldComm();
      await db.query(`select public.override_quiet_hours_hold($1, $2)`, [id, bystander.rows[0]!.id]);
    }
  );

  await expectError(
    "only a message actually HELD for later can be sent now — an unheld approved row is refused",
    /not held/,
    async () => {
      const id = await trioHeldComm();
      await db.query(`update public.communications set scheduled_for = null where id = $1`, [id]);
      await db.query(`select public.override_quiet_hours_hold($1, $2)`, [id, activation!.owner_actor_id]);
    }
  );

  await expectOk("the owner's SEND NOW collapses the hold: scheduled_for rewinds, the row carries who and when, status untouched", async () => {
    const id = await trioHeldComm();
    await db.query(`select public.override_quiet_hours_hold($1, $2)`, [id, activation!.owner_actor_id]);
    const after = await db.query<{
      status: string;
      due: boolean;
      by: string | null;
    }>(
      `select status, (scheduled_for <= now()) as due,
              attributes -> 'quiet_hours_override' ->> 'by_actor_id' as by
       from public.communications where id = $1`,
      [id]
    );
    if (after.rows[0]!.status !== "approved") throw new Error("the override touched STATUS — timing only is the law");
    if (!after.rows[0]!.due) throw new Error("scheduled_for did not rewind — the row is still held");
    if (after.rows[0]!.by !== activation!.owner_actor_id) {
      throw new Error("the row does not carry who collapsed the hold");
    }
    // A second SEND NOW finds nothing held — the door refuses, idempotently.
    let refused = false;
    try {
      await db.query(`select public.override_quiet_hours_hold($1, $2)`, [id, activation!.owner_actor_id]);
    } catch (err) {
      refused = /not held/.test(err instanceof Error ? err.message : String(err));
    }
    if (!refused) throw new Error("a second override on an already-collapsed hold was not refused");
    // File tripwires: the dispatcher honours the marker (never re-holds an
    // overridden row), and the ledger kind exists in the declared vocabulary.
    const sendSource = readFileSync(resolve(import.meta.dirname, "../src/send.ts"), "utf8");
    if (!sendSource.includes("quiet_hours_override")) {
      throw new Error("the dispatcher no longer honours the override marker — it would re-hold a recorded human decision");
    }
    const kinds = readFileSync(resolve(import.meta.dirname, "../src/event-kinds.ts"), "utf8");
    if (!kinds.includes(`"communication.quiet_hours_overridden"`)) {
      throw new Error("the override's ledger kind left the declared vocabulary");
    }
  });

  // Defect pair (2 Aug 2026, founder-observed, ledger-evidenced) — fail-loud
  // reaches every surface a failed send renders on, and a stamped-but-failed
  // message gains RETRY (0040: same body, same stamp, the gate re-earned).
  console.log("\nDefect pair — fail-loud surfaces + RETRY for stamped-but-failed (2 Aug 2026):");

  const pairFailedComm = async (): Promise<string> => {
    // The production shape: a human-stamped message the provider refused —
    // stamped through the real doors, failed through the real 0021 door.
    const t = await db.query<{ id: string }>(
      `insert into public.comm_threads (business_id, created_by, contact_id, channel)
       values ($1, $2, $3, 'email') returning id`,
      [activation!.business_id, activation!.owner_actor_id, trioContact.rows[0]!.id]
    );
    const r = await db.query<{ id: string }>(
      `insert into public.communications (business_id, created_by, thread_id, contact_id, channel, direction, status, body)
       values ($1, $2, $3, $4, 'email', 'outbound', 'draft', 'A stamped answer the provider refused.') returning id`,
      [activation!.business_id, activation!.owner_actor_id, t.rows[0]!.id, trioContact.rows[0]!.id]
    );
    await db.query(`select public.submit_communication($1, $2)`, [r.rows[0]!.id, activation!.owner_actor_id]);
    await db.query(`select public.approve_communication($1, $2)`, [r.rows[0]!.id, activation!.owner_actor_id]);
    await db.query(
      `select public.mark_communication_send_failed($1, 'graph', 'The provider refused the message. ErrorInvalidRecipients (#131030)')`,
      [r.rows[0]!.id]
    );
    return r.rows[0]!.id;
  };

  await expectError(
    "RETRY is a HUMAN act — an agent actor is refused by the database",
    /HUMAN act/,
    async () => {
      const id = await pairFailedComm();
      await db.query(`select public.retry_failed_communication($1, $2)`, [id, activation!.light_actor_id]);
    }
  );

  await expectError(
    "a human WITHOUT stamp authority cannot retry — approvals.comms (execute) or the owner, nobody else",
    /approvals\.comms/,
    async () => {
      const account = await db.query<{ account_id: string }>(
        `select account_id from public.businesses where id = $1`,
        [activation!.business_id]
      );
      const bystander = await db.query<{ id: string }>(
        `insert into public.actors (account_id, actor_type, display_name)
         values ($1, 'human', 'Ungranted Retrier') returning id`,
        [account.rows[0]!.account_id]
      );
      const id = await pairFailedComm();
      await db.query(`select public.retry_failed_communication($1, $2)`, [id, bystander.rows[0]!.id]);
    }
  );

  await expectError(
    "only a FAILED communication can be retried — an approved (merely held) row is refused",
    /Only a FAILED/,
    async () => {
      const id = await trioHeldComm();
      await db.query(`select public.retry_failed_communication($1, $2)`, [id, activation!.owner_actor_id]);
    }
  );

  await expectOk("the owner's RETRY re-arms dispatch: same body, SAME STAMP preserved, failure kept on the record, gate re-earned", async () => {
    const id = await pairFailedComm();
    const before = await db.query<{ approver: string; body: string }>(
      `select approved_by_actor_id as approver, body from public.communications where id = $1`,
      [id]
    );
    await db.query(`select public.retry_failed_communication($1, $2)`, [id, activation!.owner_actor_id]);
    const after = await db.query<{
      status: string;
      approver: string | null;
      body: string;
      failure: string | null;
      retried_by: string | null;
    }>(
      `select status, approved_by_actor_id as approver, body,
              attributes -> 'send_failure' ->> 'reason' as failure,
              attributes -> 'send_retry' ->> 'by_actor_id' as retried_by
       from public.communications where id = $1`,
      [id]
    );
    if (after.rows[0]!.status !== "approved") throw new Error(`retry left status "${after.rows[0]!.status}"`);
    if (after.rows[0]!.approver !== before.rows[0]!.approver) {
      throw new Error("the retry changed the stamp — same stamp is the ruling's letter");
    }
    if (after.rows[0]!.body !== before.rows[0]!.body) {
      throw new Error("the retry changed the body — WYSIWYS broken");
    }
    if (!after.rows[0]!.failure?.includes("#131030")) {
      throw new Error("the recorded failure left the row — it DID fail once, the record must keep saying so");
    }
    if (after.rows[0]!.retried_by !== activation!.owner_actor_id) {
      throw new Error("the row does not carry who retried");
    }
    // A second retry finds nothing failed — refused, idempotently.
    let refused = false;
    try {
      await db.query(`select public.retry_failed_communication($1, $2)`, [id, activation!.owner_actor_id]);
    } catch (err) {
      refused = /Only a FAILED/.test(err instanceof Error ? err.message : String(err));
    }
    if (!refused) throw new Error("a second retry on a re-armed row was not refused");
  });

  await expectOk("fail-loud reaches every surface — thread bubble, inbox History, enquiry timeline all render the failed state", async () => {
    // File tripwires (the s20/s22 precedent): the three surfaces keep their
    // failed arms, the retry control exists, and the ledger kind stands in
    // the declared vocabulary + the History action set.
    const surfaces: Array<[string, string[]]> = [
      [
        "../../../apps/web/app/(app)/conversations/conversations-client.tsx",
        ['message.status === "failed"', "RetrySendControl"],
      ],
      [
        "../../../apps/web/app/(app)/enquiries/[id]/page.tsx",
        ['comm.status === "failed"', "RetrySendControl"],
      ],
      [
        "../../../apps/web/app/(app)/inbox/page.tsx",
        ['"send_failed"', "RetrySendControl"],
      ],
      [
        "../../../apps/web/lib/server/queries.ts",
        ['"communication.send_failed"', "parseSendFailure"],
      ],
    ];
    for (const [file, markers] of surfaces) {
      const source = readFileSync(resolve(import.meta.dirname, file), "utf8");
      for (const marker of markers) {
        if (!source.includes(marker)) throw new Error(`${file} lost its fail-loud marker: ${marker}`);
      }
    }
    const kinds = readFileSync(resolve(import.meta.dirname, "../src/event-kinds.ts"), "utf8");
    if (!kinds.includes(`"communication.send_retried"`)) {
      throw new Error("the retry's ledger kind left the declared vocabulary");
    }
  });

  // Session 25 (founder-ordered, ledger-evidenced) — generation-failure
  // visibility + register retry-once. The engine behaved correctly and the
  // UI hid it; and a single dash slip must no longer kill a live reply.
  console.log("\nSession 25 — generation-failure visibility + register retry-once:");

  await expectOk("a register slip retries ONCE with the violation fed back, and the clean second attempt stands", async () => {
    let calls = 0;
    let secondPrompt = "";
    const fake: GenerateFn = async (request) => {
      calls += 1;
      if (calls === 1) {
        return {
          subject: null,
          body: "Hello Amina, we can help — book a consultation.",
          attestation: { attested: true, statement: "x" },
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      }
      secondPrompt = request.prompt;
      return {
        subject: null,
        body: "Hello Amina, we can help. Book a consultation at your convenience.",
        attestation: { attested: true, statement: "x" },
        usage: { input_tokens: 12, output_tokens: 6 },
      };
    };
    let retriesEvented = 0;
    const { composed, registerRetried } = await composeWithRegisterRetry(
      (inp, opts) => composeDraft(fake, inp, opts),
      s18Input("intro"),
      async (breach) => {
        retriesEvented += 1;
        if (!/em dash/.test(breach.message)) throw new Error("the breach did not name the violation");
      }
    );
    if (calls !== 2) throw new Error(`expected exactly 2 attempts, saw ${calls}`);
    if (retriesEvented !== 1) throw new Error(`the retry must be evented exactly once, saw ${retriesEvented}`);
    if (!registerRetried) throw new Error("the outcome does not state the retry");
    if (!/em dash/.test(secondPrompt)) throw new Error("the violation was not fed back into the regeneration prompt");
    if (composed.usage.input_tokens !== 22 || composed.usage.output_tokens !== 11) {
      throw new Error("both attempts must be metered spend");
    }
    if ((composed.credit_line as { register_retry?: string }).register_retry !== "em dash") {
      throw new Error("the credit line does not carry the register retry");
    }
    if (findRegisterBreach(composed.body) !== null) throw new Error("the standing body still breaches");
  });

  await expectOk("the retry is once and ONLY once — a second breach propagates to the visible-failure lane, never a loop", async () => {
    let calls = 0;
    const fake: GenerateFn = async () => {
      calls += 1;
      return {
        subject: null,
        body: "Hello Amina, we can help — always.",
        attestation: { attested: true, statement: "x" },
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    };
    let retriesEvented = 0;
    let threw: unknown = null;
    try {
      await composeWithRegisterRetry(
        (inp, opts) => composeDraft(fake, inp, opts),
        s18Input("intro"),
        async () => {
          retriesEvented += 1;
        }
      );
    } catch (err) {
      threw = err;
    }
    if (calls !== 2) throw new Error(`expected exactly 2 attempts, saw ${calls}`);
    if (retriesEvented !== 1) throw new Error(`the retry evented ${retriesEvented} times — it must event exactly once`);
    if (!(threw instanceof RegisterBreachError)) throw new Error("the second breach did not propagate");
    // Permanent for the classifier: the caller's catch events
    // light.draft_generation_failed and the failure stands VISIBLE (fix 1) —
    // no lease-retry loop ever forms from a register breach.
    if (isTransientProviderError(threw)) throw new Error("a register breach must never read as transient");
  });

  await expectOk("a reply-path register slip takes the same retry-once — tonight's defect shape, the WhatsApp reply", async () => {
    let calls = 0;
    const fake: GenerateFn = async () => {
      calls += 1;
      return calls === 1
        ? {
            subject: null,
            body: "Hello Amina, Monday–Friday works.",
            attestation: { attested: true, statement: "x" },
            usage: { input_tokens: 1, output_tokens: 1 },
          }
        : {
            subject: null,
            body: "Hello Amina, Monday to Friday works.",
            attestation: { attested: true, statement: "x" },
            usage: { input_tokens: 1, output_tokens: 1 },
          };
    };
    const { composed, registerRetried } = await composeWithRegisterRetry(
      (inp, opts) => composeReplyDraft(fake, inp, opts),
      s16ReplyInput,
      async (breach) => {
        if (breach.breach !== "en dash") throw new Error("the breach did not name the en dash");
      }
    );
    if (!registerRetried || calls !== 2) throw new Error("the reply path did not retry exactly once");
    if (findRegisterBreach(composed.body) !== null) throw new Error("the standing body still breaches");
  });

  await expectOk("generation refusals surface on the thread and the enquiry timeline — the fail-loud tripwires", async () => {
    // File tripwires (the defect-pair precedent): the surfaces keep their
    // refusal arms with the RECORDED reason, the ledger kinds stand in the
    // declared vocabulary, and both production compose sites route through
    // the shared retry-once.
    const surfaces: Array<[string, string[]]> = [
      [
        "../../../apps/web/app/(app)/conversations/conversations-client.tsx",
        ["draftRefusals", "Light&rsquo;s draft was refused", "Ask Light to draft again"],
      ],
      [
        "../../../apps/web/app/(app)/enquiries/[id]/page.tsx",
        ['"light.draft_generation_failed"', "Light&rsquo;s draft was refused", "Ask Light to draft again"],
      ],
      [
        "../../../apps/web/lib/server/queries.ts",
        ['"light.draft_generation_failed"', "draftRefusals"],
      ],
    ];
    for (const [file, markers] of surfaces) {
      const source = readFileSync(resolve(import.meta.dirname, file), "utf8");
      for (const marker of markers) {
        if (!source.includes(marker)) throw new Error(`${file} lost its refusal-visibility marker: ${marker}`);
      }
    }
    const kinds = readFileSync(resolve(import.meta.dirname, "../src/event-kinds.ts"), "utf8");
    if (!kinds.includes(`"light.draft_register_retried"`)) {
      throw new Error("the register retry's ledger kind left the declared vocabulary");
    }
    for (const file of ["../src/workflow.ts", "../src/supersede.ts"]) {
      const source = readFileSync(resolve(import.meta.dirname, file), "utf8");
      if (!source.includes("composeWithRegisterRetry")) {
        throw new Error(`${file} no longer routes composition through the register retry-once`);
      }
    }
  });

  // --- Session 26: docs true-up + small-fixes sweep ------------------------
  console.log("\nSession 26 — Record row expansion, the Files surface:");

  await expectOk("the Files listing shows only the business's own rows (RLS-shaped)", async () => {
    // Seed one file per tenant service-side (the doors that write files are
    // not under test here — the wall is).
    await db.query(
      `insert into public.files (business_id, storage_key, filename, mime_type, size_bytes, sha256, uploaded_by)
       values ($1, 's26/own-booklet.pdf', 'Spouse-Visa-Booklet.pdf', 'application/pdf', 1048576, repeat('a', 64), $2)`,
      [f.business_id, f.human_id]
    );
    await db.query(
      `insert into public.files (business_id, storage_key, filename, mime_type, size_bytes, sha256, uploaded_by)
       values ($1, 's26/other-tenant.pdf', 'Jurists-Private.pdf', 'application/pdf', 2048, repeat('b', 64), $2)`,
      [activation!.business_id, activation!.owner_actor_id]
    );
    const visibleTo = async (sub: string, email: string) => {
      await db.exec(`set role authenticated`);
      await db.exec(`set request.jwt.claim.sub = '${sub}'`);
      await db.exec(`set request.jwt.claims = '{"sub":"${sub}","email":"${email}"}'`);
      const r = await db.query<{ filename: string }>(
        `select filename from public.files where archived_at is null`
      );
      await db.exec(`reset role`);
      return r.rows.map((row) => row.filename);
    };
    const own = await visibleTo(ids.user, "owner@example.test");
    if (!own.includes("Spouse-Visa-Booklet.pdf")) throw new Error("the member cannot see their own business's file");
    if (own.includes("Jurists-Private.pdf")) throw new Error("another tenant's file leaked into the listing");
    const jurists = await visibleTo(ownerUserId, "aisha@jurists.test");
    if (!jurists.includes("Jurists-Private.pdf")) throw new Error("the Jurists owner cannot see their own file");
    if (jurists.includes("Spouse-Visa-Booklet.pdf")) throw new Error("the fixture business's file leaked to Jurists");
  });

  await expectOk("the Files surface is windowed per the 5e read law and offers no write control", async () => {
    // File tripwires (the s20/s22 precedent): the listing query reads a
    // bounded window with a COUNT aggregate, and the read-only surface draws
    // no upload or delete door (decision 116 — no control that cannot act).
    const queriesSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/lib/server/queries.ts"),
      "utf8"
    );
    const fn = queriesSource.slice(queriesSource.indexOf("export async function getBusinessFiles"));
    if (!fn.includes("pageRange(page, DEFAULT_LIST_WINDOW)")) {
      throw new Error("getBusinessFiles no longer reads a bounded window");
    }
    if (!fn.includes(`{ count: "exact", head: true }`)) {
      throw new Error("getBusinessFiles no longer counts by aggregate");
    }
    const pageSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/files/page.tsx"),
      "utf8"
    );
    if (pageSource.includes(`type="file"`) || pageSource.includes("action=") || pageSource.includes("<form")) {
      throw new Error("the read-only Files surface grew a write door");
    }
  });

  await expectOk("a Record row expands in place — 'Open enquiry' is a button inside the row, never the row's click target", async () => {
    // The pure module carries the where-does-this-lead decision (the
    // live-inbox-rules precedent) — proven component-level here.
    const engagement = recordRowTarget({ entityType: "engagement", entityId: "e-1", payload: {} });
    if (engagement?.href !== "/enquiries/e-1" || engagement.label !== "Open enquiry") {
      throw new Error("an engagement entry does not lead to its enquiry");
    }
    const contact = recordRowTarget({ entityType: "contact", entityId: "c-1", payload: {} });
    if (contact?.href !== "/contacts/c-1" || contact.label !== "Open contact") {
      throw new Error("a contact entry does not lead to its contact");
    }
    const viaPayload = recordRowTarget({ entityType: "communication", entityId: "m-1", payload: { engagement_id: "e-2" } });
    if (viaPayload?.href !== "/enquiries/e-2" || viaPayload.label !== "Open enquiry") {
      throw new Error("a payload-named engagement does not lead to its enquiry");
    }
    if (recordRowTarget({ entityType: "business", entityId: null, payload: {} }) !== null) {
      throw new Error("an entry leading nowhere invented a destination");
    }
    // File tripwire: the row is a disclosure control, the navigation lives
    // INSIDE the expansion, and the old whole-row link is gone.
    const rowSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/record/record-list.tsx"),
      "utf8"
    );
    if (!rowSource.includes("aria-expanded")) throw new Error("the Record row is no longer a disclosure control");
    if (!rowSource.includes("recordRowTarget")) throw new Error("the row no longer reads the pure target module");
    if (!rowSource.includes("<Link href={target.href}>{target.label}</Link>")) {
      throw new Error("the expanded row lost its labelled navigation button");
    }
    if (rowSource.includes("Link href={href}")) {
      throw new Error("the whole-row link returned — the row's click target must expand, never navigate");
    }
  });

  // C4 (founder-ruled 3 Aug 2026): the ruled nudge ladder lands by RE-ISSUE
  // through the definition pipeline — proven against a live-shaped v1.
  await expectOk("the re-issued workflow definition carries the ruled ladder — T+1/T+3/T+6, close ≈T+9, by re-issue only", async () => {
    // Service-side, no session — the chore's own posture.
    await db.exec(`reset role`);
    await db.exec(`set request.jwt.claim.sub = ''`);
    await db.exec(`set request.jwt.claims = ''`);
    // A live-shaped v1: the current production ladder (waits 2/3/4).
    const v1 = await db.query<{ id: string }>(
      `insert into public.workflow_definitions (business_id, created_by, key, version, template_id, trigger, status, description_plain)
       values ($1, $2, 'meta_lead_to_consultation', 1, $3, '{"action":"s26.ladder_smoke"}'::jsonb, 'draft',
               'Ladder smoke: the pre-ruling nudge cadence.') returning id`,
      [f.business_id, f.human_id, f.template_id]
    );
    const v1Id = v1.rows[0]!.id;
    const V1_STEPS: [string, number, string, string, number][] = [
      ["intro_ack", 1, "draft_comm", '{"template":"intro_v1","channel":"email","await_approval":true,"companion_channels":["whatsapp"]}', 3],
      ["call_task", 2, "create_task", '{"title":"Call {{first_name}}","assignee":"owner","due":{"hours":2}}', 2],
      ["nurture_wait_t2", 3, "wait", '{"wait":{"days":2},"cancel_on_reply":true}', 0],
      ["nurture_t2", 4, "draft_comm", '{"template":"nurture_t2_v1","channel":"whatsapp","fallback_channel":"email","cancel_on_reply":true}', 3],
      ["nurture_wait_t5", 5, "wait", '{"wait":{"days":3},"cancel_on_reply":true}', 0],
      ["nurture_t5", 6, "draft_comm", '{"template":"nurture_t5_v1","channel":"email","cancel_on_reply":true}', 3],
      ["nurture_wait_t9", 7, "wait", '{"wait":{"days":4},"cancel_on_reply":true}', 0],
      ["nurture_t9", 8, "draft_comm", '{"template":"nurture_t9_v1","channel":"email","cancel_on_reply":true}', 3],
      ["close_wait", 9, "wait", '{"wait":{"days":3},"cancel_on_reply":true}', 0],
      ["auto_close", 10, "close", '{"stage":"unresponsive"}', 2],
    ];
    for (const [key, sort, kind, config, gate] of V1_STEPS) {
      await db.query(
        `insert into public.workflow_steps (business_id, created_by, definition_id, key, sort_order, kind, config, gate_level)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [f.business_id, f.human_id, v1Id, key, sort, kind, config, gate]
      );
    }
    await db.query(`select public.submit_workflow_definition($1, $2)`, [v1Id, f.human_id]);
    await db.query(`select public.approve_workflow_definition($1, $2)`, [v1Id, f.human_id]);

    const oldSteps = (
      await db.query<LadderStep>(
        `select key, sort_order, kind, config, gate_level from public.workflow_steps
         where definition_id = $1 and archived_at is null order by sort_order`,
        [v1Id]
      )
    ).rows;
    if (carriesRuledLadder(oldSteps)) throw new Error("the pre-ruling ladder read as already ruled");

    // The re-issue, exactly as the chore performs it: new version through
    // the pipeline, transformed steps, superseded version paused.
    const v2 = await db.query<{ id: string }>(
      `insert into public.workflow_definitions (business_id, created_by, key, version, template_id, trigger, status, description_plain)
       values ($1, $2, 'meta_lead_to_consultation', 2, $3, '{"action":"s26.ladder_smoke"}'::jsonb, 'draft', $4) returning id`,
      [f.business_id, f.human_id, f.template_id, ruledLadderDescription()]
    );
    const v2Id = v2.rows[0]!.id;
    for (const step of reissueNudgeLadderSteps(oldSteps)) {
      await db.query(
        `insert into public.workflow_steps (business_id, created_by, definition_id, key, sort_order, kind, config, gate_level)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [f.business_id, f.human_id, v2Id, step.key, step.sort_order, step.kind, JSON.stringify(step.config), step.gate_level]
      );
    }
    await db.query(`select public.submit_workflow_definition($1, $2)`, [v2Id, f.human_id]);
    await db.query(`select public.approve_workflow_definition($1, $2)`, [v2Id, f.human_id]);
    await db.query(`select public.pause_workflow_definition($1, $2)`, [v1Id, f.human_id]);

    const statuses = await db.query<{ id: string; status: string }>(
      `select id, status from public.workflow_definitions where id = any(array[$1, $2]::uuid[])`,
      [v1Id, v2Id]
    );
    const statusOf = new Map(statuses.rows.map((r) => [r.id, r.status]));
    if (statusOf.get(v2Id) !== "active") throw new Error("the re-issued version is not active");
    if (statusOf.get(v1Id) !== "paused") throw new Error("the superseded version did not pause");

    const newSteps = (
      await db.query<LadderStep>(
        `select key, sort_order, kind, config, gate_level from public.workflow_steps
         where definition_id = $1 and archived_at is null order by sort_order`,
        [v2Id]
      )
    ).rows;
    if (!carriesRuledLadder(newSteps)) throw new Error("the re-issued version does not carry the ruled ladder");
    const byKey = new Map(newSteps.map((s) => [s.key, s]));
    const wait = (key: string) => (byKey.get(key)?.config as { wait?: { days?: number } })?.wait?.days;
    if (wait("nurture_wait_t1") !== 1 || wait("nurture_wait_t3") !== 2 || wait("nurture_wait_t6") !== 3 || wait("close_wait") !== 3) {
      throw new Error(`ruled waits wrong: t1=${wait("nurture_wait_t1")} t3=${wait("nurture_wait_t3")} t6=${wait("nurture_wait_t6")} close=${wait("close_wait")}`);
    }
    const n1 = byKey.get("nurture_t1")?.config as Record<string, unknown> | undefined;
    if (n1?.template !== "nurture_t2_v1" || n1?.channel !== "whatsapp" || n1?.fallback_channel !== "email" || n1?.cancel_on_reply !== true) {
      throw new Error("nudge 1 lost its WhatsApp-with-email-fallback shape or its template identity");
    }
    const n3 = byKey.get("nurture_t3")?.config as Record<string, unknown> | undefined;
    const n6 = byKey.get("nurture_t6")?.config as Record<string, unknown> | undefined;
    if (n3?.channel !== "email" || n6?.channel !== "email") throw new Error("nudges 2/3 lost their email channel");
    const intro = byKey.get("intro_ack")?.config as Record<string, unknown> | undefined;
    if (intro?.await_approval !== true || !Array.isArray(intro?.companion_channels)) {
      throw new Error("the intro changed — it was ruled unchanged");
    }
    if (byKey.get("auto_close")?.kind !== "close") throw new Error("auto_close changed shape");
    // Idempotency: the ruled ladder reads as ruled — a chore re-run re-issues nothing.
    if (!carriesRuledLadder(reissueNudgeLadderSteps(newSteps))) {
      throw new Error("re-running the transformation broke the ruled ladder");
    }
  });

  // C5 (founder-ruled 3 Aug 2026): the unset-business quiet-hours default
  // resolves from the installed template's declaration — one source; the
  // constant only for install-less businesses.
  await expectOk("quiet hours: the unset-business default is the TEMPLATE's declaration; the constant only when install-less", async () => {
    const declared = { start: "21:30", end: "07:30" };
    // Unset settings + an installed declaration → the template's window.
    const viaTemplate = resolveQuietHours({}, declared);
    if (viaTemplate?.start !== "21:30" || viaTemplate?.end !== "07:30") {
      throw new Error("an unset business did not inherit the template's declared default");
    }
    // Unset settings, no install → the last-resort constant.
    const installLess = resolveQuietHours({}, null);
    if (installLess?.start !== QUIET_HOURS_DEFAULT.start || installLess?.end !== QUIET_HOURS_DEFAULT.end) {
      throw new Error("an install-less business lost the constant fallback");
    }
    // A firm-set window WINS over the declaration; an explicit null disables.
    const firmSet = resolveQuietHours({ quiet_hours: { start: "19:00", end: "09:00" } }, declared);
    if (firmSet?.start !== "19:00") throw new Error("a firm-set window lost to the template default");
    if (resolveQuietHours({ quiet_hours: null }, declared) !== null) {
      throw new Error("a deliberate disable was overridden by the template default");
    }
    // A malformed declaration never disables the hold — it falls to the constant.
    if (declaredTemplateQuietHours({ start: "9pm", end: "07:30" }) !== null) {
      throw new Error("a malformed declaration validated");
    }
    const malformed = resolveQuietHours({}, { start: "9pm", end: "07:30" } as { start: string; end: string });
    if (malformed?.start !== QUIET_HOURS_DEFAULT.start) {
      throw new Error("a malformed declaration did not fall to the constant");
    }
    // The declared v3 content carries the declaration the resolver reads.
    const v3 = await db.query<{ declared: { start?: string; end?: string } | null }>(
      `select definition #> '{business_identity,defaults,quiet_hours}' as declared
       from public.template_definitions where key = 'uk_immigration_advisory'
       order by version desc limit 1`
    );
    const fromStore = declaredTemplateQuietHours(v3.rows[0]?.declared);
    if (!fromStore) throw new Error("the installed v3 definition no longer declares its quiet-hours default");
    // File tripwire: the dispatch hold resolves THROUGH the template default.
    const sendSource = readFileSync(resolve(import.meta.dirname, "../src/send.ts"), "utf8");
    if (!sendSource.includes("resolveQuietHours(facts.settings, facts.template_quiet_hours)")) {
      throw new Error("the dispatch hold no longer resolves through the installed template's default");
    }
    if (!sendSource.includes("getInstalledQuietHoursDefault")) {
      throw new Error("dispatch business facts no longer carry the installed template default");
    }
  });

  await expectOk("attachment chips wear the real paperclip — the ⎘ stand-in glyph is gone", async () => {
    const sites: [string, boolean][] = [
      ["../../../apps/web/app/(app)/inbox/inbox-card.tsx", true],
      ["../../../apps/web/app/(app)/settings/knowledge-tab.tsx", true],
      ["../../../apps/web/app/(app)/settings/knowledge-editor.tsx", true],
      ["../../../apps/web/app/(app)/inbox/page.tsx", false],
    ];
    for (const [file, wantsIcon] of sites) {
      const source = readFileSync(resolve(import.meta.dirname, file), "utf8");
      if (source.includes("⎘")) throw new Error(`${file} still renders the ⎘ stand-in`);
      if (wantsIcon && !source.includes("Paperclip")) throw new Error(`${file} lost its paperclip icon`);
    }
  });

  // --- Session 27: returning leads + the three post-close rulings ----------
  console.log("\nSession 27 — returning leads (D158) + rulings D159/D160/D161:");

  await db.exec(`reset role`);
  await db.exec(`set request.jwt.claim.sub = ''`);
  await db.exec(`set request.jwt.claims = ''`);

  // A returning-lead fixture: a known contact with a consented email channel
  // and an existing enquiry + thread in the fixture business.
  const s27Contact = await db.query<{ id: string }>(
    `insert into public.contacts (business_id, created_by, type, display_name, given_name, status, locale)
     values ($1, $2, 'person', 'Rukhsana Bibi', 'Rukhsana', 'active', 'en-GB') returning id`,
    [f.business_id, f.agent_id]
  );
  const s27ContactId = s27Contact.rows[0]!.id;
  await db.query(
    `insert into public.contact_channels (business_id, created_by, contact_id, channel, value, is_primary, consent)
     values ($1, $2, $3, 'email', 'rukhsana@example.test', true, '{"transactional": true, "marketing": true}'::jsonb)`,
    [f.business_id, f.agent_id, s27ContactId]
  );
  const s27Eng = await db.query<{ id: string }>(
    `insert into public.engagements (business_id, created_by, template_type_id, title, stage_id, owner_actor_id, external_refs)
     values ($1, $2, $3, 'Rukhsana Bibi — enquiry', $4, $5,
             '[{"system":"meta","external_id":"s27_lead_1"}]'::jsonb) returning id`,
    [f.business_id, f.agent_id, f.type_id, f.stage_id, f.human_id]
  );
  const s27EngId = s27Eng.rows[0]!.id;
  const s27Thread = await db.query<{ id: string }>(
    `insert into public.comm_threads (business_id, created_by, contact_id, engagement_id, channel, subject)
     values ($1, $2, $3, $4, 'email', 'Rukhsana Bibi — enquiry') returning id`,
    [f.business_id, f.agent_id, s27ContactId, s27EngId]
  );
  const s27ThreadId = s27Thread.rows[0]!.id;

  await expectOk("the frontier's ruled unit: the SAME leadgen id is claimed once, ever — the webhook claim and the ingest guard", async () => {
    await db.query(
      `insert into public.meta_webhook_events (leadgen_id, page_id, payload) values ('s27_lead_1', 'p', '{}'::jsonb)`
    );
    let refused = false;
    try {
      await db.query(
        `insert into public.meta_webhook_events (leadgen_id, page_id, payload) values ('s27_lead_1', 'p', '{}'::jsonb)`
      );
    } catch (err) {
      refused = /duplicate key/.test(err instanceof Error ? err.message : String(err));
    }
    if (!refused) throw new Error("a replayed leadgen id was claimed twice");
    // The ingest guard's own shape: the engagement carrying the ref is found.
    const found = await db.query<{ id: string }>(
      `select id from public.engagements
       where external_refs @> '[{"system":"meta","external_id":"s27_lead_1"}]'::jsonb`
    );
    if (!found.rows.some((r) => r.id === s27EngId)) {
      throw new Error("the same-submission idempotency lookup cannot find the claimed ref");
    }
  });

  await expectOk("a NEW leadgen id on a known contact resolves to that contact — deterministically, never by guess", async () => {
    const rows = [
      { contact_id: "c1", channel: "email", value: "a@x.test" },
      { contact_id: "c1", channel: "phone", value: "+441111" },
      { contact_id: "c2", channel: "email", value: "b@x.test" },
    ];
    if (resolveKnownContactId(rows, "A@X.TEST", null) !== "c1") throw new Error("an exact email match did not resolve");
    if (resolveKnownContactId(rows, null, "+441111") !== "c1") throw new Error("an exact phone match did not resolve");
    if (resolveKnownContactId(rows, "nobody@x.test", "+449999") !== null) throw new Error("a stranger resolved to someone");
    // Ambiguity falls through, then resolves to no one — never a merge guess.
    const clash = [
      { contact_id: "c1", channel: "email", value: "shared@x.test" },
      { contact_id: "c2", channel: "email", value: "shared@x.test" },
      { contact_id: "c2", channel: "phone", value: "+442222" },
    ];
    if (resolveKnownContactId(clash, "shared@x.test", "+442222") !== "c2") {
      throw new Error("an ambiguous email did not fall through to the phone match");
    }
    if (resolveKnownContactId(clash, "shared@x.test", null) !== null) {
      throw new Error("an ambiguous match resolved instead of standing down");
    }
    // File tripwire: ingest consults the resolver BEFORE any contact insert
    // and routes known contacts through the returning path.
    const metaSource = readFileSync(resolve(import.meta.dirname, "../src/meta.ts"), "utf8");
    const resolveAt = metaSource.indexOf("findKnownContactId(db");
    const contactInsertAt = metaSource.indexOf(`.from("contacts")`);
    if (resolveAt === -1 || !metaSource.includes("processReturningLead")) {
      throw new Error("ingest no longer routes known contacts through the returning path");
    }
    if (contactInsertAt !== -1 && resolveAt > contactInsertAt) {
      throw new Error("ingest creates the contact before resolving whether it already exists");
    }
  });

  await expectOk("the system marker is a neutral internal fact — thread to top, unread badge, arrival tone, changed fields highlighted", async () => {
    const diff = diffFormAnswers(
      [
        { name: "email", label: "Email", value: "rukhsana@example.test" },
        { name: "phone_number", label: "Phone number", value: "+92306999" },
      ],
      [
        { name: "email", label: "Email", value: "rukhsana@example.test" },
        { name: "phone_number", label: "Phone number", value: "+44777111" },
        { name: "situation", label: "Situation", value: "Husband refused entry" },
      ]
    );
    if (diff.length !== 3) throw new Error("the diff lost rows");
    if (diff[0]!.changed) throw new Error("an unchanged field read as changed");
    if (!diff[1]!.changed || diff[1]!.previous_value !== "+92306999") throw new Error("a changed field lost its previous value");
    if (!diff[2]!.changed || diff[2]!.previous_value !== null) throw new Error("a new field did not read as new");
    const body = buildMarkerBody({ form_label: "Spouse Visa 23/04/2024", submitted_at: "2026-08-04", diff });
    if (!/was \+92306999/.test(body)) throw new Error("the marker body does not carry the changed-from value");
    if (/—|–/.test(body)) throw new Error("the marker body carries an em or en dash");

    // The marker row: direction internal, kind in attributes — the 0036
    // trigger bumps the thread to the top; last_inbound_at makes it unread.
    const beforeRow = await db.query<{ last_activity_at: string | null }>(
      `select last_activity_at from public.comm_threads where id = $1`,
      [s27ThreadId]
    );
    const markerAttrs = JSON.stringify({
      kind: "returning_lead_marker",
      marker: {
        form_id: "751097307189312",
        form_label: "Spouse Visa 23/04/2024",
        lead_id: "s27_lead_2",
        submitted_at: "2026-08-04T09:00:00Z",
        answers: diff,
      },
    });
    await db.query(
      `insert into public.communications
         (business_id, created_by, thread_id, contact_id, engagement_id, channel, direction, status, body, attributes)
       values ($1, $2, $3, $4, $5, 'email', 'internal', 'received', $6, $7::jsonb)`,
      [f.business_id, f.agent_id, s27ThreadId, s27ContactId, s27EngId, body, markerAttrs]
    );
    await db.query(`update public.comm_threads set last_inbound_at = now() where id = $1`, [s27ThreadId]);
    const after = await db.query<{ last_activity_at: string | null; is_unread: boolean }>(
      `select last_activity_at, is_unread from public.comm_threads where id = $1`,
      [s27ThreadId]
    );
    if (!after.rows[0]!.last_activity_at || after.rows[0]!.last_activity_at === beforeRow.rows[0]!.last_activity_at) {
      throw new Error("the marker did not bump the thread's activity ordering");
    }
    if (!after.rows[0]!.is_unread) throw new Error("the marker did not set the unread badge");

    // Arrival tone (D158a): the marker rings; ordinary internal rows do not.
    if (!classifyCommChange("INSERT", { direction: "internal", attributes: { kind: "returning_lead_marker" } }, null).tone) {
      throw new Error("the marker's arrival does not ring");
    }
    if (classifyCommChange("INSERT", { direction: "internal", attributes: {} }, null).tone) {
      throw new Error("an ordinary internal row rings");
    }

    // The client-side parse round-trips the stored shape.
    const parsed = parseReturningMarker("returning_lead_marker", JSON.parse(markerAttrs).marker);
    if (!parsed || parsed.formLabel !== "Spouse Visa 23/04/2024") throw new Error("the marker facts do not parse");
    if (parsed.answers.filter((a) => a.changed).length !== 2) throw new Error("the parsed diff lost its highlights");
    if (parseReturningMarker("something_else", {}) !== null) throw new Error("a non-marker row parsed as a marker");

    // Neutral chrome + the transcript exclusion stand in code (tripwires).
    const convSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/conversations/conversations-client.tsx"),
      "utf8"
    );
    if (!convSource.includes("returningMarker") || !convSource.includes("self-center")) {
      throw new Error("the conversation marker card lost its neutral centred render");
    }
    const enquirySource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/enquiries/[id]/page.tsx"),
      "utf8"
    );
    if (!enquirySource.includes("comm.returningMarker") || !enquirySource.includes(`Pin tone="neutral"`)) {
      throw new Error("the enquiry timeline marker card lost its neutral pin");
    }
    const supersedeSource = readFileSync(resolve(import.meta.dirname, "../src/supersede.ts"), "utf8");
    if (!supersedeSource.includes(`(r.direction === "inbound" && r.status === "received")`)) {
      throw new Error("the transcript filter changed — internal markers may be leaking into the model transcript");
    }
  });

  await expectOk("the returning draft carries no cold intro and no duplicate booklet — both compose paths, by prompt and by suppression", async () => {
    const returning = {
      prior_route: "Spouse/Family",
      form_label: "Spouse Visa 23/04/2024",
      resubmitted_at: "2026-08-04",
      changed_lines: ["Phone number: +44777111 (was +92306999)"],
      booklet_already_sent: true,
    };
    let sawSystem = "";
    let sawPrompt = "";
    const fake: GenerateFn = async (request) => {
      sawSystem = request.system;
      sawPrompt = request.prompt;
      return {
        subject: null,
        body: "Hello Rukhsana, thank you for coming back to us. We can help with the next step.",
        attestation: { attested: true, statement: "Complies." },
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    };
    await composeDraft(fake, { ...s18Input("intro"), returning, attachment: null });
    if (!/Never introduce the firm as if this were first contact/.test(sawSystem)) {
      throw new Error("the intro prompt does not forbid the cold introduction");
    }
    if (!/Never offer, promise or mention sending it again/.test(sawSystem)) {
      throw new Error("the intro prompt does not forbid the duplicate booklet");
    }
    if (!/\(was \+92306999\)/.test(sawPrompt)) throw new Error("the changed details did not reach the prompt");

    const { prompt } = assembleReplyPrompt({ ...s16ReplyInput, returning, new_inbound_count: 0 });
    if (!/Never introduce the firm as if this were first contact/.test(prompt)) {
      throw new Error("the reply prompt does not forbid the cold introduction");
    }
    if (!/returning form submission \(above\) is what needs answering/.test(prompt)) {
      throw new Error("a settled marker with no client message does not steer the reply");
    }

    // Suppression + the companion stand-down are in the workflow drafter.
    const workflowSource = readFileSync(resolve(import.meta.dirname, "../src/workflow.ts"), "utf8");
    if (!workflowSource.includes("contactAlreadyReceivedFile") || !workflowSource.includes("if (bookletAlreadySent) guide = null")) {
      throw new Error("the intro drafter no longer suppresses an already-sent booklet");
    }
    if (!workflowSource.includes("returning lead — the approved intro template is a cold introduction")) {
      throw new Error("the WhatsApp companion no longer stands down for returning leads");
    }
    // D159's prompt half: reference an attachment only when one is attached.
    const draftingSource = readFileSync(resolve(import.meta.dirname, "../src/drafting.ts"), "utf8");
    if (!draftingSource.includes("Never write that anything is attached or enclosed")) {
      throw new Error("the generation prompt lost the attachment-honesty instruction");
    }
  });

  await expectOk("enquiry linkage: a successor names its predecessor, never itself; the surfaces read the link on both timelines", async () => {
    const successor = await db.query<{ id: string; predecessor_engagement_id: string }>(
      `insert into public.engagements
         (business_id, created_by, template_type_id, title, stage_id, owner_actor_id, predecessor_engagement_id)
       values ($1, $2, $3, 'Rukhsana Bibi — enquiry', $4, $5, $6) returning id, predecessor_engagement_id`,
      [f.business_id, f.agent_id, f.type_id, f.stage_id, f.human_id, s27EngId]
    );
    if (successor.rows[0]!.predecessor_engagement_id !== s27EngId) throw new Error("the linkage did not persist");
    let refused = false;
    try {
      await db.query(`update public.engagements set predecessor_engagement_id = id where id = $1`, [
        successor.rows[0]!.id,
      ]);
    } catch (err) {
      refused = /engagements_no_self_predecessor/.test(err instanceof Error ? err.message : String(err));
    }
    if (!refused) throw new Error("a self-predecessor was accepted");
    // Both timelines: the ledger kinds exist and the surfaces render them.
    const kinds = readFileSync(resolve(import.meta.dirname, "../src/event-kinds.ts"), "utf8");
    for (const kind of [
      `"engagement.resubmission_received"`,
      `"engagement.successor_opened"`,
      `"engagement.opened_from_predecessor"`,
      `"communication.returning_marker_posted"`,
      `"engagement.route_set"`,
    ]) {
      if (!kinds.includes(kind)) throw new Error(`the declared vocabulary lost ${kind}`);
    }
    const queriesSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/lib/server/queries.ts"),
      "utf8"
    );
    if (!queriesSource.includes("predecessor_engagement_id") || !queriesSource.includes("successors")) {
      throw new Error("the enquiry read layer no longer carries the linkage");
    }
    const pageSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/enquiries/[id]/page.tsx"),
      "utf8"
    );
    if (!pageSource.includes("detail.predecessor") || !pageSource.includes("detail.successors")) {
      throw new Error("the enquiry page no longer shows the linkage on both sides");
    }
    const languageSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/lib/record-language.ts"),
      "utf8"
    );
    for (const marker of ["engagement.resubmission_received", "engagement.successor_opened", "engagement.route_set"]) {
      if (!languageSource.includes(marker)) throw new Error(`record language lost ${marker}`);
    }
  });

  await expectOk("a new enquiry enrols on the ACTIVE definition — a paused version cannot start runs, and a key consumes an event once", async () => {
    const defs = await db.query<{ id: string; status: string; version: number }>(
      `select id, status, version from public.workflow_definitions
       where business_id = $1 and key = 'meta_lead_to_consultation' and archived_at is null
       order by version`,
      [f.business_id]
    );
    const active = defs.rows.find((d) => d.status === "active");
    const paused = defs.rows.find((d) => d.status === "paused");
    if (!active || !paused) throw new Error("the s26 fixture definitions (active v2, paused v1) are missing");

    const enrol = await db.query<{ id: string }>(
      `insert into public.engagements (business_id, created_by, template_type_id, title, stage_id, owner_actor_id)
       values ($1, $2, $3, 'Enrolment probe — enquiry', $4, $5) returning id`,
      [f.business_id, f.agent_id, f.type_id, f.stage_id, f.human_id]
    );
    const trigger = await db.query<{ id: string }>(
      `insert into public.events (business_id, actor_id, action, entity_type, entity_id, payload)
       values ($1, $2, 'engagement.created', 'engagement', $3, '{"attribution":{"source":"meta"}}'::jsonb) returning id`,
      [f.business_id, f.agent_id, enrol.rows[0]!.id]
    );
    let pausedRefused = false;
    try {
      await db.query(`select public.start_workflow_run($1, $2, $3, $4)`, [
        paused.id,
        enrol.rows[0]!.id,
        f.agent_id,
        trigger.rows[0]!.id,
      ]);
    } catch (err) {
      pausedRefused = /Only an active definition/.test(err instanceof Error ? err.message : String(err));
    }
    if (!pausedRefused) throw new Error("a paused definition started a run");
    await db.query(`select public.start_workflow_run($1, $2, $3, $4)`, [
      active.id,
      enrol.rows[0]!.id,
      f.agent_id,
      trigger.rows[0]!.id,
    ]);
    // The KEY-scoped claim (0038): the same trigger event can never start a
    // second run for this key, whatever engagement or version asks.
    const enrol2 = await db.query<{ id: string }>(
      `insert into public.engagements (business_id, created_by, template_type_id, title, stage_id, owner_actor_id)
       values ($1, $2, $3, 'Enrolment probe 2 — enquiry', $4, $5) returning id`,
      [f.business_id, f.agent_id, f.type_id, f.stage_id, f.human_id]
    );
    let claimed = false;
    try {
      await db.query(`select public.start_workflow_run($1, $2, $3, $4)`, [
        active.id,
        enrol2.rows[0]!.id,
        f.agent_id,
        trigger.rows[0]!.id,
      ]);
    } catch (err) {
      claimed = /duplicate key/.test(err instanceof Error ? err.message : String(err));
    }
    if (!claimed) throw new Error("the key consumed one trigger event twice");
    // And the returning path emits exactly this trigger for successors.
    const returningSource = readFileSync(resolve(import.meta.dirname, "../src/returning-leads.ts"), "utf8");
    if (!returningSource.includes(`action: "engagement.created"`)) {
      throw new Error("a successor enquiry no longer emits the enrolment trigger");
    }
  });

  await expectOk("attachment honesty (D159): a body claiming an attachment with none attached fails pre-flight NAMING the mismatch", async () => {
    const check = async (body: string, comm: string | null) => {
      const r = await db.query<{ out: { checks: Array<{ key: string; pass: boolean; detail: string | null }> } }>(
        `select private.comm_preflight($1, $2, 'email', $3, $4, '{}'::jsonb, false) as out`,
        [f.business_id, s27ContactId, body, comm]
      );
      return r.rows[0]!.out.checks.find((c) => c.key === "attachment")!;
    };
    const attached = await check("Please find attached our Spouse Visa guide.", null);
    if (attached.pass) throw new Error("a body claiming an attachment passed with nothing attached");
    if (!/"attached"/.test(attached.detail ?? "")) throw new Error("the mismatch is not named (attached)");
    const enclosed = await check("I have enclosed the booklet for you.", null);
    if (enclosed.pass) throw new Error("an enclosure claim passed with nothing attached");
    if (!/"enclosed"/.test(enclosed.detail ?? "")) throw new Error("the mismatch is not named (enclosed)");
    const silent = await check("Hello, thank you for your message.", null);
    if (!silent.pass) throw new Error("a body referencing nothing failed the attachment check");
  });

  await expectOk("attachment honesty (D159): present-but-unmentioned passes; present-and-referenced passes", async () => {
    const file = await db.query<{ id: string }>(
      `insert into public.files (business_id, storage_key, filename, mime_type, size_bytes, sha256, uploaded_by)
       values ($1, 's27/guide.pdf', 'Spouse-Guide.pdf', 'application/pdf', 1024, repeat('c', 64), $2) returning id`,
      [f.business_id, f.human_id]
    );
    const comm = await db.query<{ id: string }>(
      `insert into public.communications
         (business_id, created_by, thread_id, contact_id, engagement_id, channel, direction, status, body)
       values ($1, $2, $3, $4, $5, 'email', 'outbound', 'draft', 'Guide attached for you.') returning id`,
      [f.business_id, f.agent_id, s27ThreadId, s27ContactId, s27EngId]
    );
    await db.query(
      `insert into public.file_links (business_id, file_id, entity_type, entity_id, role)
       values ($1, $2, 'communication', $3, 'attachment')`,
      [f.business_id, file.rows[0]!.id, comm.rows[0]!.id]
    );
    const run = async (body: string) => {
      const r = await db.query<{ out: { checks: Array<{ key: string; pass: boolean }> } }>(
        `select private.comm_preflight($1, $2, 'email', $3, $4, '{}'::jsonb, false) as out`,
        [f.business_id, s27ContactId, body, comm.rows[0]!.id]
      );
      return r.rows[0]!.out.checks.find((c) => c.key === "attachment")!;
    };
    if (!(await run("Guide attached for you.")).pass) {
      throw new Error("a referenced, genuinely linked attachment failed");
    }
    if (!(await run("Hello, here is a short note.")).pass) {
      throw new Error("attachment-present-but-unmentioned failed — D159 says it passes");
    }
  });

  await expectOk("route precedence (D161): human > form_answer > light > form_default — Light never overwrites human or form answers", async () => {
    // Pure mirrors first — the polite pre-checks match the door's ladder.
    if (routeSourceRank("human") <= routeSourceRank("form_answer")) throw new Error("rank order broken");
    if (!lightMaySetRoute(null) || !lightMaySetRoute("form_default")) throw new Error("Light lost its lawful writes");
    if (lightMaySetRoute("light") || lightMaySetRoute("form_answer") || lightMaySetRoute("human")) {
      throw new Error("Light may overwrite what it never may");
    }

    const eng = await db.query<{ id: string }>(
      `insert into public.engagements (business_id, created_by, template_type_id, title, stage_id, owner_actor_id)
       values ($1, $2, $3, 'Precedence probe — enquiry', $4, $5) returning id`,
      [f.business_id, f.agent_id, f.type_id, f.stage_id, f.human_id]
    );
    const engId = eng.rows[0]!.id;
    const set = (route: string, source: string, actor: string) =>
      db.query(`select public.set_engagement_route($1, $2, $3, $4, null)`, [engId, route, source, actor]);
    const expectRefusal = async (route: string, source: string, actor: string, pattern: RegExp) => {
      let refused = false;
      try {
        await set(route, source, actor);
      } catch (err) {
        refused = pattern.test(err instanceof Error ? err.message : String(err));
      }
      if (!refused) throw new Error(`source "${source}" was not refused as expected`);
    };
    const currentSource = async () => {
      const r = await db.query<{ s: string | null }>(
        `select attributes ->> 'visa_route_source' as s from public.engagements where id = $1`,
        [engId]
      );
      return r.rows[0]!.s;
    };

    await set("visitor", "form_default", f.agent_id);
    if ((await currentSource()) !== "form_default") throw new Error("form_default did not land on an unset field");
    await expectRefusal("student", "form_default", f.agent_id, /precedence/);
    await set("spouse_family", "light", f.agent_id);
    if ((await currentSource()) !== "light") throw new Error("Light could not refine a form default");
    await expectRefusal("student", "light", f.agent_id, /precedence/);
    await set("ilr", "form_answer", f.agent_id);
    if ((await currentSource()) !== "form_answer") throw new Error("a form answer could not overrule Light");
    await expectRefusal("student", "light", f.agent_id, /precedence/);
    await set("student", "human", f.human_id);
    if ((await currentSource()) !== "human") throw new Error("a human could not reclassify");
    // Human final against machine writes — every machine source refuses.
    await expectRefusal("visitor", "light", f.agent_id, /precedence/);
    await expectRefusal("visitor", "form_answer", f.agent_id, /precedence/);
    await expectRefusal("visitor", "form_default", f.agent_id, /precedence/);
    // A human may correct a human.
    await set("naturalisation", "human", f.human_id);
    if ((await currentSource()) !== "human") throw new Error("a human correction was refused");
    // Actor-type honesty: a human actor never records machine provenance,
    // and machine actors never record the human stamp.
    await expectRefusal("visitor", "human", f.agent_id, /requires a human actor/);
    const engFresh = await db.query<{ id: string }>(
      `insert into public.engagements (business_id, created_by, template_type_id, title, stage_id, owner_actor_id)
       values ($1, $2, $3, 'Provenance probe — enquiry', $4, $5) returning id`,
      [f.business_id, f.agent_id, f.type_id, f.stage_id, f.human_id]
    );
    let honest = false;
    try {
      await db.query(`select public.set_engagement_route($1, 'visitor', 'light', $2, null)`, [
        engFresh.rows[0]!.id,
        f.human_id,
      ]);
    } catch (err) {
      honest = /never machine provenance/.test(err instanceof Error ? err.message : String(err));
    }
    if (!honest) throw new Error("a human actor recorded machine provenance");
  });

  await expectOk("the route moves ONLY through the door — direct writes refused, born-with refused, signed-in sessions write human only", async () => {
    let direct = false;
    try {
      await db.query(
        `update public.engagements set attributes = jsonb_set(attributes, '{visa_route}', '"student"') where id = $1`,
        [s27EngId]
      );
    } catch (err) {
      direct = /set_engagement_route/.test(err instanceof Error ? err.message : String(err));
    }
    if (!direct) throw new Error("a direct route write slipped past the door — service role included");
    let born = false;
    try {
      await db.query(
        `insert into public.engagements (business_id, created_by, template_type_id, title, stage_id, owner_actor_id, attributes)
         values ($1, $2, $3, 'Born-with probe', $4, $5, '{"visa_route":"student"}'::jsonb)`,
        [f.business_id, f.agent_id, f.type_id, f.stage_id, f.human_id]
      );
    } catch (err) {
      born = /never born with one/.test(err instanceof Error ? err.message : String(err));
    }
    if (!born) throw new Error("an engagement was born with a route, skipping the door");
    // A signed-in member may reclassify as HUMAN (D161c: any team member
    // with enquiry access) — and may never claim machine provenance.
    await db.exec(`set role authenticated`);
    await db.exec(`set request.jwt.claim.sub = '${ids.member}'`);
    await db.exec(`set request.jwt.claims = '{"sub":"${ids.member}","email":"member@example.test"}'`);
    await db.query(`select public.set_engagement_route($1, 'spouse_family', 'human', $2, 'caller actually needs spouse route')`, [
      s27EngId,
      h2.human2_id,
    ]);
    let machineClaim = false;
    try {
      await db.query(`select public.set_engagement_route($1, 'student', 'light', $2, null)`, [s27EngId, h2.human2_id]);
    } catch (err) {
      machineClaim = /only reclassify as source "human"/.test(err instanceof Error ? err.message : String(err));
    }
    await db.exec(`reset role`);
    await db.exec(`set request.jwt.claim.sub = ''`);
    await db.exec(`set request.jwt.claims = ''`);
    if (!machineClaim) throw new Error("a signed-in session claimed machine provenance");
    const routeNow = await db.query<{ r: string | null; s: string | null }>(
      `select attributes ->> 'visa_route' as r, attributes ->> 'visa_route_source' as s from public.engagements where id = $1`,
      [s27EngId]
    );
    if (routeNow.rows[0]!.r !== "spouse_family" || routeNow.rows[0]!.s !== "human") {
      throw new Error("the member's reclassification did not stand");
    }
  });

  await expectOk("a declared vocabulary refuses undeclared routes; the per-form default mapping resolves deterministically", async () => {
    // The Jurists install carries the 0024 declaration — an undeclared key
    // is refused, a declared one lands.
    const jEng = await db.query<{ id: string }>(
      `insert into public.engagements (business_id, created_by, template_type_id, title, stage_id, owner_actor_id)
       values ($1, $2, $3, 'Vocabulary probe — enquiry', $4, $5) returning id`,
      [activation!.business_id, activation!.light_actor_id, installedTypeId, installedNewLeadId, activation!.owner_actor_id]
    );
    let refused = false;
    try {
      await db.query(`select public.set_engagement_route($1, 'not_a_route', 'human', $2, null)`, [
        jEng.rows[0]!.id,
        activation!.owner_actor_id,
      ]);
    } catch (err) {
      refused = /declared route vocabulary/.test(err instanceof Error ? err.message : String(err));
    }
    if (!refused) throw new Error("an undeclared route slipped past the declared vocabulary");
    await db.query(`select public.set_engagement_route($1, 'spouse_family', 'human', $2, null)`, [
      jEng.rows[0]!.id,
      activation!.owner_actor_id,
    ]);

    // D161(a): the mapping's settings shape — the live Spouse form's id maps
    // to the declared spouse_family key; an unmapped form resolves nothing.
    // JUDGMENT: D161(a)'s "defaults to spouse" maps to the declared
    // vocabulary key `spouse_family` — the installed v3 route list carries
    // no bare `spouse` key (Session 27 pre-flight).
    const settings = {
      meta: { form_route_defaults: { "751097307189312": { route: "spouse_family", label: "Spouse Visa 23/04/2024" } } },
    };
    const hit = resolveFormRouteDefault(settings, "751097307189312");
    if (hit?.route !== "spouse_family" || hit.label !== "Spouse Visa 23/04/2024") {
      throw new Error("the per-form default did not resolve");
    }
    if (resolveFormRouteDefault(settings, "999") !== null) throw new Error("an unmapped form resolved a default");
    if (resolveFormRouteDefault({}, "751097307189312") !== null) throw new Error("empty settings resolved a default");
    // A form's OWN route answer outranks the default (provenance form_answer).
    const fromAnswers = routeFromFormAnswers([
      { name: "which_visa_route", label: "Which visa route", value: "Spouse visa for my wife" },
    ]);
    if (fromAnswers?.route !== "spouse_family") throw new Error("a route question's answer did not map");
    if (routeFromFormAnswers([{ name: "email", label: "Email", value: "x@y.test" }]) !== null) {
      throw new Error("a non-route answer invented a route");
    }
    // Ingest consults answers first, then the mapping (file order tripwire).
    const returningSource = readFileSync(resolve(import.meta.dirname, "../src/returning-leads.ts"), "utf8");
    const answersAt = returningSource.indexOf("routeFromFormAnswers(answers)");
    const defaultAt = returningSource.indexOf("resolveFormRouteDefault(businesses[0]?.settings");
    if (answersAt === -1 || defaultAt === -1 || answersAt > defaultAt) {
      throw new Error("ingest no longer prefers the form's own answer over the per-form default");
    }
  });

  await expectOk("Light's route read is ONE floor-tier call whose evidence is the form and the person's words — undeclared keys never survive (D161b vocabulary rule, D179c ordering)", async () => {
    const options = [
      { key: "spouse_family", label: "Spouse/Family" },
      { key: "ilr", label: "ILR" },
    ];
    let calls = 0;
    let sawModel = "";
    let sawSystem = "";
    let sawPrompt = "";
    const confident: ClassifyFn = async (request) => {
      calls += 1;
      sawModel = request.model;
      sawSystem = request.system;
      sawPrompt = request.prompt;
      return {
        key: "ilr",
        reason: "the enquirer's own words ask about indefinite leave to remain",
        usage: { input_tokens: 40, output_tokens: 12 },
      };
    };
    const read = await classifyRoute(confident, {
      enquiry_title: "Amina Khan — enquiry",
      form_label: "Spouse Visa 23/04/2024",
      form_answers: [{ name: "q", label: "Question", value: "I have lived here five years and want ILR" }],
      options,
    });
    if (calls !== 1) throw new Error("the route read must be ONE call");
    if (sawModel !== LIGHT_MODEL_FLOOR.model) throw new Error("the read left the floor tier");
    if (read.key !== "ilr") throw new Error("the confident read did not survive");
    if (!/Spouse Visa 23\/04\/2024/.test(sawPrompt) || !/want ILR/.test(sawPrompt)) {
      throw new Error("the evidence (form name, the person's own words) was not in the prompt");
    }
    if (!/otherwise set key to null/i.test(sawSystem) || !/never guess/i.test(sawSystem)) {
      throw new Error("the confident-or-null contract left the classification prompt");
    }
    // An undeclared key is normalised to null — never written (D161b).
    const undeclared: ClassifyFn = async () => ({
      key: "made_up",
      reason: "x",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const refused = await classifyRoute(undeclared, { enquiry_title: "t", form_answers: [], options });
    if (refused.key !== null || !/undeclared/.test(refused.reason)) {
      throw new Error("an undeclared route key survived the read");
    }
    const bad = normaliseRouteClassification(options, { key: "made_up", reason: "x" });
    if (bad?.key !== null || !/undeclared/.test(bad?.reason ?? "")) {
      throw new Error("an undeclared route key survived normalisation");
    }
    // No declared vocabulary = no read, no call.
    calls = 0;
    const none = await classifyRoute(confident, { enquiry_title: "t", form_answers: [], options: [] });
    if (calls !== 0 || none.key !== null) throw new Error("a read ran with no vocabulary declared");
  });

  await expectOk("route resolution completes BEFORE composition (D179c): both composers key retrieval and booklet on the resolved route, the read is evented, the door still stamps light provenance", async () => {
    // Ordering tripwires: in BOTH production composers the resolution call
    // precedes retrieval, and retrieval receives what it settled — never
    // the raw text match.
    const workflowSource = readFileSync(resolve(import.meta.dirname, "../src/workflow.ts"), "utf8");
    const supersedeSource = readFileSync(resolve(import.meta.dirname, "../src/supersede.ts"), "utf8");
    for (const [name, source] of [
      ["workflow.ts", workflowSource],
      ["supersede.ts", supersedeSource],
    ] as const) {
      const resolveAt = source.indexOf("resolveEngagementRoute(db, {");
      const retrieveAt = source.indexOf("retrieveKnowledgeEntries(");
      if (resolveAt === -1) throw new Error(`${name} no longer resolves the route`);
      if (retrieveAt === -1) throw new Error(`${name} no longer retrieves knowledge`);
      if (resolveAt > retrieveAt) throw new Error(`${name}: retrieval runs before route resolution — D179c ordering broken`);
    }
    if (!/retrieveKnowledgeEntries\(db, run\.business_id, leadText, resolved\.route\)/.test(workflowSource)) {
      throw new Error("workflow retrieval no longer keys on the resolved route");
    }
    if (!/resolvedRoute\s*\)/.test(supersedeSource.slice(supersedeSource.indexOf("retrieveKnowledgeEntries")))) {
      throw new Error("reply retrieval no longer keys on the resolved route");
    }
    // The booklet follows the resolved route ONLY — and only when one
    // resolved: no route, no route-specific booklet (a missing booklet is
    // recoverable; a wrong one is not).
    if (!workflowSource.includes(`picked.channel === "email" && resolved.route`)) {
      throw new Error("the booklet gate no longer requires a resolved route");
    }
    if (!workflowSource.includes("findPublishedRouteGuide(db, run.business_id, [resolved.route])")) {
      throw new Error("booklet selection no longer keys on the resolved route alone");
    }
    if (workflowSource.includes("retrieval.route_matches,")) {
      throw new Error("booklet selection still consults raw text matches");
    }
    // The resolution wrapper: the ladder first, Light only over unset or
    // form_default, the read EVENTED (confident or abstained — D161d), the
    // confident write through the 0042 door with light provenance.
    const routesSource = readFileSync(resolve(import.meta.dirname, "../src/routes.ts"), "utf8");
    if (!routesSource.includes("if (input.current_route && !lightMaySetRoute(input.current_source)) return standing")) {
      throw new Error("resolution no longer respects the 0042 ladder before reading");
    }
    if (!routesSource.includes("ROUTE_EVENT_KINDS.routeRead")) {
      throw new Error("the route read is no longer evented — 'ran and abstained' would be a silence (D161d)");
    }
    if (!routesSource.includes(`source: "light"`) || !routesSource.includes("setEngagementRoute")) {
      throw new Error("routes.ts no longer applies Light's read through the 0042 door");
    }
    if (!routesSource.includes(`rpc("set_engagement_route"`) || !routesSource.includes("emitEvent")) {
      throw new Error("the route wrapper separated the door from the ledger");
    }
    // The superseded ride-along is fully out: one door, no second classifier.
    if (workflowSource.includes("route_options") || supersedeSource.includes("route_options")) {
      throw new Error("the superseded ride-along classification is still wired in a composer");
    }
  });

  await expectOk("enquiry truth-timing (D160): 'classifying' only while a read may arrive; the timeline's draft entry shows attachment state", async () => {
    const queriesSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/lib/server/queries.ts"),
      "utf8"
    );
    if (!queriesSource.includes("liveRun && !agentDrafted")) {
      throw new Error("the classifying signal no longer distinguishes a run that already drafted (and abstained)");
    }
    if (!queriesSource.includes("visaRouteSource")) throw new Error("the read layer lost the route's provenance");
    const pageSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/enquiries/[id]/page.tsx"),
      "utf8"
    );
    if (!pageSource.includes("Classifying route…")) {
      throw new Error("the enquiry page no longer says 'classifying' while a run is in flight");
    }
    if (!pageSource.includes("Route not yet classified")) {
      throw new Error("the honest resting state left the page");
    }
    if (!pageSource.includes("comm.attachments.map")) {
      throw new Error("the timeline's draft entry no longer shows attachment state");
    }
    if (!pageSource.includes("RouteReclassifyControl")) {
      throw new Error("the human reclassify control left the enquiry page");
    }
  });

  // ---------------------------------------------------------------------
  console.log("\nSession 28 — returning-lead channel refinement (D174) + whole-set contact search:");

  await db.exec(`reset role`);
  await db.exec(`set request.jwt.claim.sub = ''`);
  await db.exec(`set request.jwt.claims = ''`);

  await expectOk("same email, new phone: the match stands and the phone is planned as an additional channel", async () => {
    const rows = [
      { contact_id: "c1", channel: "email", value: "amina@x.test" },
      { contact_id: "c1", channel: "phone", value: "+441111" },
    ];
    if (resolveKnownContactId(rows, "amina@x.test", "+447999") !== "c1") {
      throw new Error("a new phone value blocked an email resolution");
    }
    // D186: the plan now carries whatsapp beside phone — the submitted
    // phone is its value, enriched like a sibling.
    const plan = planChannelEnrichment(rows, "amina@x.test", "+447999");
    if (plan.length !== 2) throw new Error("the enrichment plan lost a channel");
    if (!plan.some((p) => p.channel === "phone" && p.value === "+447999")) {
      throw new Error("the new phone was not planned as enrichment");
    }
    if (!plan.some((p) => p.channel === "whatsapp" && p.value === "+447999")) {
      throw new Error("the new whatsapp channel was not planned as enrichment (D186)");
    }
    // The orchestration writes it with the form's consent and events it with
    // provenance (tripwires — the write path is TS over Supabase).
    const returningSource = readFileSync(resolve(import.meta.dirname, "../src/returning-leads.ts"), "utf8");
    if (!returningSource.includes(`source: "meta_lead_form"`) || !returningSource.includes("enrichment channel insert")) {
      throw new Error("the enrichment write lost the form-carried consent");
    }
    if (!returningSource.includes("RETURNING_EVENT_KINDS.channelAdded")) {
      throw new Error("the enrichment write is no longer evented");
    }
    const metaSource = readFileSync(resolve(import.meta.dirname, "../src/meta.ts"), "utf8");
    if (!metaSource.includes("known.enrich")) {
      throw new Error("ingest no longer hands the enrichment plan to the returning path");
    }
    const kinds = readFileSync(resolve(import.meta.dirname, "../src/event-kinds.ts"), "utf8");
    if (!kinds.includes(`"contact.channel_added"`)) {
      throw new Error("the declared vocabulary lost contact.channel_added");
    }
    // The schema accepts exactly the write the engine issues: an additional
    // channel row with the form's consent, and its ledger event.
    const enrichContact = await db.query<{ id: string }>(
      `insert into public.contacts (business_id, created_by, type, display_name)
       values ($1, $2, 'person', 'Enrichment Lead') returning id`,
      [f.business_id, f.agent_id]
    );
    await db.query(
      `insert into public.contact_channels (business_id, created_by, contact_id, channel, value, is_primary, consent)
       values ($1, $2, $3, 'phone', '+447999', false,
               '{"marketing": true, "transactional": true, "granted_at": "2026-08-04T09:00:00Z", "source": "meta_lead_form"}'::jsonb)`,
      [f.business_id, f.agent_id, enrichContact.rows[0]!.id]
    );
    const evt = await db.query<{ id: string }>(
      `insert into public.events (business_id, actor_id, action, entity_type, entity_id, payload)
       values ($1, $2, 'contact.channel_added', 'contact', $3,
               '{"channel":"phone","value":"+447999","lead_id":"s28_lead_1","form_id":"751097307189312","consent_source":"meta_lead_form"}'::jsonb)
       returning id`,
      [f.business_id, f.agent_id, enrichContact.rows[0]!.id]
    );
    if (!evt.rows[0]!.id) throw new Error("the channel_added event did not land");
  });

  await expectOk("same phone, new email: the mirror resolves and plans the email, lower-cased", async () => {
    const rows = [
      { contact_id: "c1", channel: "email", value: "amina@x.test" },
      { contact_id: "c1", channel: "phone", value: "+441111" },
    ];
    if (resolveKnownContactId(rows, "fresh@x.test", "+441111") !== "c1") {
      throw new Error("a new email value blocked a phone resolution");
    }
    const plan = planChannelEnrichment(rows, "FRESH@X.TEST", "+441111");
    if (!plan.some((p) => p.channel === "email" && p.value === "fresh@x.test")) {
      throw new Error("the new email was not planned (lower-cased) as enrichment");
    }
    // D186: the matched contact holds phone +441111 but no whatsapp row —
    // the returning path enriches whatsapp too.
    if (plan.length !== 2 || !plan.some((p) => p.channel === "whatsapp" && p.value === "+441111")) {
      throw new Error("the missing whatsapp channel was not planned as enrichment (D186)");
    }
  });

  await expectOk("a cross-channel conflict resolves to no one — fresh lead, deterministically, identities never merged", async () => {
    const rows = [
      { contact_id: "c1", channel: "email", value: "amina@x.test" },
      { contact_id: "c2", channel: "phone", value: "+442222" },
    ];
    // D174(c): email → c1, phone → c2 — twice, same answer, no one.
    for (let i = 0; i < 2; i += 1) {
      if (resolveKnownContactId(rows, "amina@x.test", "+442222") !== null) {
        throw new Error("a cross-channel conflict resolved to a contact");
      }
    }
    // D174(d): the other value shared by SEVERAL other contacts is equally
    // conflict — belonging to another contact, not enrichment.
    const shared = [
      ...rows,
      { contact_id: "c3", channel: "phone", value: "+442222" },
    ];
    if (resolveKnownContactId(shared, "amina@x.test", "+442222") !== null) {
      throw new Error("a value on several other contacts did not read as conflict");
    }
    // A value the MATCHED contact also holds is no conflict — the match stands.
    const withMatched = [
      { contact_id: "c1", channel: "email", value: "amina@x.test" },
      { contact_id: "c1", channel: "phone", value: "+443333" },
      { contact_id: "c2", channel: "phone", value: "+443333" },
    ];
    if (resolveKnownContactId(withMatched, "amina@x.test", "+443333") !== "c1") {
      throw new Error("a shared value including the matched contact broke the match");
    }
    // The s27 ambiguity ladder stands unchanged (173b).
    const clash = [
      { contact_id: "c1", channel: "email", value: "shared@x.test" },
      { contact_id: "c2", channel: "email", value: "shared@x.test" },
      { contact_id: "c2", channel: "phone", value: "+444444" },
    ];
    if (resolveKnownContactId(clash, "shared@x.test", "+444444") !== "c2") {
      throw new Error("ambiguous email no longer falls through to the phone match");
    }
  });

  await expectOk("a changed name never blocks resolution — channels only — and the marker highlights it as a changed field", async () => {
    // The resolver's signature takes channel values only; ingest hands it
    // exactly those (tripwire), so the submitted name cannot participate.
    const metaSource = readFileSync(resolve(import.meta.dirname, "../src/meta.ts"), "utf8");
    if (!metaSource.includes("findKnownContactId(db, binding.business_id, email || null, phone || null)")) {
      throw new Error("ingest no longer resolves on channel values alone");
    }
    const diff = diffFormAnswers(
      [
        { name: "full_name", label: "Full name", value: "Mudassir Mukhtar" },
        { name: "email", label: "Email", value: "amina@x.test" },
      ],
      [
        { name: "full_name", label: "Full name", value: "Mudassir M." },
        { name: "email", label: "Email", value: "amina@x.test" },
      ]
    );
    const nameRow = diff.find((d) => d.name === "full_name");
    if (!nameRow?.changed || nameRow.previous_value !== "Mudassir Mukhtar") {
      throw new Error("a changed name is not highlighted with its previous value");
    }
    if (diff.find((d) => d.name === "email")?.changed) {
      throw new Error("an unchanged channel read as changed");
    }
    if (!/was Mudassir Mukhtar/.test(buildMarkerBody({ form_label: "Enquiry form", submitted_at: "2026-08-04", diff }))) {
      throw new Error("the marker body does not carry the name change");
    }
  });

  await expectOk("enrichment is idempotent — the same new value on a later submission finds its own row and stands down", async () => {
    // After the first enrichment the rows the resolver reads INCLUDE the
    // added values — the second plan is empty; one row, ever. D186: the
    // first enrichment wrote whatsapp too, and its row stands the plan down.
    const afterFirst = [
      { contact_id: "c1", channel: "email", value: "amina@x.test" },
      { contact_id: "c1", channel: "phone", value: "+447999" },
      { contact_id: "c1", channel: "whatsapp", value: "+447999" },
    ];
    if (planChannelEnrichment(afterFirst, "amina@x.test", "+447999").length !== 0) {
      throw new Error("an already-held value was planned again");
    }
    if (planChannelEnrichment(afterFirst, null, "+447999").length !== 0) {
      throw new Error("a phone-only resubmission planned a duplicate");
    }
  });

  // --- Whole-set contact search (Workstream B) ---------------------------
  // Fixture: 25 alphabetically-early contacts push the target past the
  // first window (20); the target matches by name, email and phone.
  await db.query(
    `insert into public.contacts (business_id, created_by, type, display_name)
     select $1, $2, 'person', 'Aaaa Lead ' || lpad(n::text, 2, '0') from generate_series(1, 25) n`,
    [f.business_id, f.agent_id]
  );
  const s28Target = await db.query<{ id: string }>(
    `insert into public.contacts (business_id, created_by, type, display_name)
     values ($1, $2, 'person', 'Mudassir Mukhtar') returning id`,
    [f.business_id, f.agent_id]
  );
  const s28TargetId = s28Target.rows[0]!.id;
  await db.query(
    `insert into public.contact_channels (business_id, created_by, contact_id, channel, value, is_primary, consent)
     values ($1, $2, $3, 'email', 'mudassir@example.test', true, '{"transactional": true}'::jsonb),
            ($1, $2, $3, 'phone', '+447700900123', true, '{"transactional": true}'::jsonb)`,
    [f.business_id, f.agent_id, s28TargetId]
  );
  // A second business holding a look-alike contact — the RLS wall's probe.
  const s28Other = await db.query<{ contact_id: string }>(
    `
    with u as (
      insert into auth.users (id, email) values ('00000000-0000-4000-8000-000000000028', 'other-owner@example.test') returning id
    ), acc as (
      insert into public.accounts (name, owner_user_id) select 'Other Account', id from u returning id
    ), biz as (
      insert into public.businesses (account_id, name) select id, 'Other Business' from acc returning id, account_id
    ), actor as (
      insert into public.actors (account_id, actor_type, display_name, user_id)
      select account_id, 'human', 'Other Owner', '00000000-0000-4000-8000-000000000028' from biz returning id
    ), c as (
      insert into public.contacts (business_id, created_by, type, display_name)
      select biz.id, actor.id, 'person', 'Mudassir Other' from biz, actor returning id
    ), ch as (
      insert into public.contact_channels (business_id, created_by, contact_id, channel, value)
      select biz.id, actor.id, c.id, 'email', 'mudassir@other.test' from biz, actor, c returning id
    )
    select (select id from c) as contact_id
    `
  );
  const s28OtherContactId = s28Other.rows[0]!.contact_id;

  await expectOk("the first page of the book does not hold the target — the founder-found live shape", async () => {
    const pageOne = await db.query<{ id: string }>(
      `select id from public.contacts
       where business_id = $1 and archived_at is null
       order by display_name asc limit 20 offset 0`,
      [f.business_id]
    );
    if (pageOne.rows.some((r) => r.id === s28TargetId)) {
      throw new Error("the fixture no longer pushes the target off page 1 — the smoke proves nothing");
    }
  });

  await expectOk("search finds the off-page contact by name, by email and by phone — the whole set, never the loaded page", async () => {
    // The exact legs getContacts issues: name ilike + channel value ilike
    // (email and phone channels), business-scoped, live rows only, then the
    // windowed read filtered by the resolved id set.
    const legs = async (q: string) => {
      const names = await db.query<{ id: string }>(
        `select id from public.contacts
         where business_id = $1 and archived_at is null and display_name ilike $2 limit 50`,
        [f.business_id, `%${q}%`]
      );
      const channels = await db.query<{ contact_id: string }>(
        `select contact_id from public.contact_channels
         where business_id = $1 and archived_at is null and channel in ('email', 'phone') and value ilike $2 limit 50`,
        [f.business_id, `%${q}%`]
      );
      const idSet = [...new Set([...names.rows.map((r) => r.id), ...channels.rows.map((r) => r.contact_id)])];
      if (idSet.length === 0) return [];
      const windowed = await db.query<{ id: string }>(
        `select id from public.contacts
         where business_id = $1 and archived_at is null and id = any($2::uuid[])
         order by display_name asc limit 20 offset 0`,
        [f.business_id, idSet]
      );
      return windowed.rows.map((r) => r.id);
    };
    for (const [probe, q] of [
      ["name", "Mudassir"],
      ["email", "mudassir@example"],
      ["phone", "7700900123"],
    ] as const) {
      const found = await legs(q);
      if (!found.includes(s28TargetId)) throw new Error(`the ${probe} search missed the off-page contact`);
    }
    // The read layer and the surface carry the shape (tripwires): server-side
    // legs in getContacts, the page passing q, the client debouncing into the
    // URL instead of filtering the loaded page.
    const queriesSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/lib/server/queries.ts"),
      "utf8"
    );
    if (!queriesSource.includes("CONTACT_SEARCH_BOUND")) {
      throw new Error("getContacts lost its bounded search legs");
    }
    const listSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/contacts/contacts-list.tsx"),
      "utf8"
    );
    if (listSource.includes("ch.value.toLowerCase().includes")) {
      throw new Error("the contacts search filters the loaded page again — the founder-found defect");
    }
    if (!listSource.includes("router.replace") || !listSource.includes("setTimeout")) {
      throw new Error("the contacts search is no longer debounced into the URL");
    }
    const pageSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/contacts/page.tsx"),
      "utf8"
    );
    if (!pageSource.includes("getContacts(Number(params.page ?? \"1\"), q)")) {
      throw new Error("the contacts page no longer hands the query to the server read");
    }
  });

  await expectOk("search never returns another business's contacts — the RLS wall holds without the business filter", async () => {
    await db.exec(`set role authenticated`);
    await db.exec(`set request.jwt.claim.sub = '${ids.user}'`);
    // No business_id filter at all: RLS alone must scope the read.
    const names = await db.query<{ id: string }>(
      `select id from public.contacts where archived_at is null and display_name ilike '%Mudassir%'`
    );
    const channels = await db.query<{ contact_id: string }>(
      `select contact_id from public.contact_channels
       where archived_at is null and channel in ('email', 'phone') and value ilike '%mudassir@%'`
    );
    await db.exec(`reset role`);
    const seen = new Set([...names.rows.map((r) => r.id), ...channels.rows.map((r) => r.contact_id)]);
    if (!seen.has(s28TargetId)) throw new Error("the member cannot find their own business's contact");
    if (seen.has(s28OtherContactId)) throw new Error("another business's contact leaked through the search");
  });

  console.log("\nSession 30 — honesty + controls sweep:");
  await db.exec(`reset role`);
  await db.exec(`set request.jwt.claim.sub = ''`);
  await db.exec(`set request.jwt.claims = ''`);

  // --- WS B3: the chore-stamp decision (the v4/v5 incident, D169) --------
  // A re-run whose earlier staging is still pending must STAMP that staging,
  // never mint a duplicate version. Proven end-to-end in a dedicated
  // business so the s26 ladder fixtures stand untouched.
  await expectOk("a chore re-run finds its own pending staging and stamps it — no duplicate version is created", async () => {
    const fix = await db.query<{ business_id: string; human_id: string; template_id: string }>(
      `
      with u as (
        insert into auth.users (id, email) values ('00000000-0000-4000-8000-000000000030', 'ladder-owner@example.test') returning id
      ), acc as (
        insert into public.accounts (name, owner_user_id) select 'Ladder Account', id from u returning id
      ), biz as (
        insert into public.businesses (account_id, name) select id, 'Ladder Business' from acc returning id, account_id
      ), human as (
        insert into public.actors (account_id, actor_type, display_name, user_id)
        select account_id, 'human', 'Ladder Owner', '00000000-0000-4000-8000-000000000030' from biz returning id
      ), tpl as (
        insert into public.templates (business_id, vertical) select id, 'test_vertical' from biz returning id
      )
      select
        (select id from biz) as business_id,
        (select id from human) as human_id,
        (select id from tpl) as template_id
      `
    );
    const b = fix.rows[0]!;

    // v1 active with the pre-ruling waits (2/3/4 + close 3).
    const v1 = await db.query<{ id: string }>(
      `insert into public.workflow_definitions (business_id, created_by, key, version, template_id, trigger, status, description_plain)
       values ($1, $2, 'meta_lead_to_consultation', 1, $3, '{"action":"s30.ladder_smoke"}'::jsonb, 'draft',
               'Ladder smoke: the pre-ruling cadence.') returning id`,
      [b.business_id, b.human_id, b.template_id]
    );
    const v1Id = v1.rows[0]!.id;
    const V1_WAITS: [string, number, string][] = [
      ["nurture_wait_t2", 1, '{"wait":{"days":2},"cancel_on_reply":true}'],
      ["nurture_wait_t5", 2, '{"wait":{"days":3},"cancel_on_reply":true}'],
      ["nurture_wait_t9", 3, '{"wait":{"days":4},"cancel_on_reply":true}'],
      ["close_wait", 4, '{"wait":{"days":3},"cancel_on_reply":true}'],
    ];
    for (const [key, sort, config] of V1_WAITS) {
      await db.query(
        `insert into public.workflow_steps (business_id, created_by, definition_id, key, sort_order, kind, config, gate_level)
         values ($1, $2, $3, $4, $5, 'wait', $6::jsonb, 0)`,
        [b.business_id, b.human_id, v1Id, key, sort, config]
      );
    }
    await db.query(`select public.submit_workflow_definition($1, $2)`, [v1Id, b.human_id]);
    await db.query(`select public.approve_workflow_definition($1, $2)`, [v1Id, b.human_id]);

    // The flag-swallowed first run: v2 staged through the pipeline and left
    // at pending_approval — exactly what the chore's default mode produces.
    const loadSteps = async (defId: string) =>
      (
        await db.query<LadderStep>(
          `select key, sort_order, kind, config, gate_level from public.workflow_steps
           where definition_id = $1 and archived_at is null order by sort_order`,
          [defId]
        )
      ).rows;
    const v2 = await db.query<{ id: string }>(
      `insert into public.workflow_definitions (business_id, created_by, key, version, template_id, trigger, status, description_plain)
       values ($1, $2, 'meta_lead_to_consultation', 2, $3, '{"action":"s30.ladder_smoke"}'::jsonb, 'draft', $4) returning id`,
      [b.business_id, b.human_id, b.template_id, ruledLadderDescription()]
    );
    const v2Id = v2.rows[0]!.id;
    for (const step of reissueNudgeLadderSteps(await loadSteps(v1Id))) {
      await db.query(
        `insert into public.workflow_steps (business_id, created_by, definition_id, key, sort_order, kind, config, gate_level)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [b.business_id, b.human_id, v2Id, step.key, step.sort_order, step.kind, JSON.stringify(step.config), step.gate_level]
      );
    }
    await db.query(`select public.submit_workflow_definition($1, $2)`, [v2Id, b.human_id]);

    // The re-run's decision, on the rows as the chore reads them.
    const versions = (
      await db.query<{ id: string; version: number; status: string }>(
        `select id, version, status from public.workflow_definitions
         where business_id = $1 and key = 'meta_lead_to_consultation' and archived_at is null
         order by version desc`,
        [b.business_id]
      )
    ).rows;
    const stepsById = new Map<string, LadderStep[]>();
    for (const v of versions) stepsById.set(v.id, await loadSteps(v.id));
    const decision = chooseReissueAction(versions, stepsById);
    if (decision.action !== "stamp") {
      throw new Error(`the re-run decided to ${decision.action} — it must stamp its own pending staging`);
    }
    if (decision.target.id !== v2Id) throw new Error("the stamp target is not the pending staging");

    // The stamp, as the chore performs it: approve the staging, pause v1.
    await db.query(`select public.approve_workflow_definition($1, $2)`, [decision.target.id, b.human_id]);
    await db.query(`select public.pause_workflow_definition($1, $2)`, [decision.active.id, b.human_id]);

    const after = (
      await db.query<{ version: number; status: string }>(
        `select version, status from public.workflow_definitions
         where business_id = $1 and key = 'meta_lead_to_consultation' and archived_at is null
         order by version`,
        [b.business_id]
      )
    ).rows;
    if (after.length !== 2) throw new Error(`a duplicate version was created — ${after.length} versions exist, expected 2`);
    if (after.find((r) => r.version === 2)?.status !== "active") throw new Error("the staged v2 did not become active");
    if (after.find((r) => r.version === 1)?.status !== "paused") throw new Error("v1 did not pause");

    // Once stamped, a further re-run stands down.
    const stepsAfter = new Map<string, LadderStep[]>();
    for (const v of versions) stepsAfter.set(v.id, await loadSteps(v.id));
    const again = chooseReissueAction(
      (
        await db.query<{ id: string; version: number; status: string }>(
          `select id, version, status from public.workflow_definitions
           where business_id = $1 and key = 'meta_lead_to_consultation' and archived_at is null
           order by version desc`,
          [b.business_id]
        )
      ).rows,
      stepsAfter
    );
    if (again.action !== "skip") throw new Error("a third run did not stand down after the stamp");

    // A withdrawn staging is terminal — never stamped, always a fresh issue.
    const oldSteps: LadderStep[] = V1_WAITS.map(([key, sort, config]) => ({
      key,
      sort_order: sort,
      kind: "wait",
      config: JSON.parse(config) as Record<string, unknown>,
      gate_level: 0,
    }));
    const ruledSteps = reissueNudgeLadderSteps(oldSteps);
    const withdrawnCase = chooseReissueAction(
      [
        { id: "def-active", version: 3, status: "active" },
        { id: "def-withdrawn", version: 4, status: "withdrawn" },
      ],
      new Map([
        ["def-active", oldSteps],
        ["def-withdrawn", ruledSteps],
      ])
    );
    if (withdrawnCase.action !== "issue" || withdrawnCase.version !== 5) {
      throw new Error("a withdrawn staging must never be stamped — the decision must issue a fresh version");
    }

    // Tripwire: the chore consults the shared decision, not its own arithmetic.
    const choreSource = readFileSync(resolve(import.meta.dirname, "reissue-nudge-ladder.ts"), "utf8");
    if (!choreSource.includes("chooseReissueAction")) {
      throw new Error("the chore no longer consults chooseReissueAction — the v4/v5 incident can recur");
    }
    if (choreSource.includes("Math.max(...versions.map")) {
      throw new Error("the chore regrew its own version arithmetic beside the shared decision");
    }
  });

  // --- WS B2: the WhatsApp card renders env-provenance truth -------------
  await expectOk("the WhatsApp card tells the truth: a grant connects, env credentials connect via environment, absence alone is not-connected", async () => {
    const grant = whatsAppConnectionState(true, true);
    if (!grant.connected || grant.provenance !== "grant") {
      throw new Error("a live grant must read as the grant-door connection");
    }
    const env = whatsAppConnectionState(false, true);
    if (!env.connected || env.provenance !== "environment") {
      throw new Error("env credentials must read as connected via environment — never an unearned negative");
    }
    const neither = whatsAppConnectionState(false, false);
    if (neither.connected || neither.provenance !== null) {
      throw new Error("no grant and no env credentials must read as not connected");
    }
    // Tripwires: the read layer consults live credential presence; the card
    // names the provenance rather than inventing a grant.
    const queriesSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/lib/server/queries.ts"),
      "utf8"
    );
    if (!queriesSource.includes("readWhatsAppEnv() !== null") || !queriesSource.includes("whatsAppConnectionState(")) {
      throw new Error("getIntegrationStates no longer reads live WhatsApp credential presence");
    }
    const tabSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/settings/integrations-tab.tsx"),
      "utf8"
    );
    if (!tabSource.includes('provenance === "environment"') || !tabSource.includes("connected · env")) {
      throw new Error("the integrations card no longer names the environment provenance");
    }
  });

  // --- WS B1: whole-set conversation search (the s28 pattern, D175) ------
  // Fixture: 20 filler threads with future activity own page 1; the target
  // thread sits a year back — findable only by querying the whole set.
  const s30Filler = await db.query<{ id: string }>(
    `insert into public.contacts (business_id, created_by, type, display_name)
     values ($1, $2, 'person', 'Filler Correspondent') returning id`,
    [f.business_id, f.agent_id]
  );
  const s30FillerId = s30Filler.rows[0]!.id;
  await db.query(
    `insert into public.comm_threads (business_id, created_by, contact_id, channel, last_activity_at)
     select $1, $2, $3, 'email', now() + interval '1 hour' + (n || ' minutes')::interval
     from generate_series(1, 20) n`,
    [f.business_id, f.agent_id, s30FillerId]
  );
  const s30Contact = await db.query<{ id: string }>(
    `insert into public.contacts (business_id, created_by, type, display_name)
     values ($1, $2, 'person', 'Sadia Winterbourne') returning id`,
    [f.business_id, f.agent_id]
  );
  const s30ContactId = s30Contact.rows[0]!.id;
  await db.query(
    `insert into public.contact_channels (business_id, created_by, contact_id, channel, value, is_primary, consent)
     values ($1, $2, $3, 'email', 'sadia@wintermail.test', true, '{"transactional": true}'::jsonb),
            ($1, $2, $3, 'phone', '+447700900456', true, '{"transactional": true}'::jsonb),
            ($1, $2, $3, 'whatsapp', '447700900987', true, '{"transactional": true}'::jsonb)`,
    [f.business_id, f.agent_id, s30ContactId]
  );
  const s30Thread = await db.query<{ id: string }>(
    `insert into public.comm_threads (business_id, created_by, contact_id, channel, last_activity_at)
     values ($1, $2, $3, 'email', now() - interval '365 days') returning id`,
    [f.business_id, f.agent_id, s30ContactId]
  );
  const s30ThreadId = s30Thread.rows[0]!.id;
  // A second business holding a look-alike conversation — the RLS probe.
  const s30Other = await db.query<{ thread_id: string }>(
    `
    with u as (
      insert into auth.users (id, email) values ('00000000-0000-4000-8000-000000000031', 'convo-owner@example.test') returning id
    ), acc as (
      insert into public.accounts (name, owner_user_id) select 'Convo Account', id from u returning id
    ), biz as (
      insert into public.businesses (account_id, name) select id, 'Convo Business' from acc returning id, account_id
    ), actor as (
      insert into public.actors (account_id, actor_type, display_name, user_id)
      select account_id, 'human', 'Convo Owner', '00000000-0000-4000-8000-000000000031' from biz returning id
    ), c as (
      insert into public.contacts (business_id, created_by, type, display_name)
      select biz.id, actor.id, 'person', 'Sadia Other' from biz, actor returning id
    ), ch as (
      insert into public.contact_channels (business_id, created_by, contact_id, channel, value)
      select biz.id, actor.id, c.id, 'email', 'sadia@othermail.test' from biz, actor, c returning id
    ), th as (
      insert into public.comm_threads (business_id, created_by, contact_id, channel, last_activity_at)
      select biz.id, actor.id, c.id, 'email', now() from biz, actor, c returning id
    )
    select (select id from th) as thread_id
    `
  );
  const s30OtherThreadId = s30Other.rows[0]!.thread_id;

  await expectOk("the first page of conversations does not hold the target thread — the s28 defect's live shape", async () => {
    const pageOne = await db.query<{ id: string }>(
      `select id from public.comm_threads
       where business_id = $1 and archived_at is null and last_activity_at is not null
       order by last_activity_at desc limit 20 offset 0`,
      [f.business_id]
    );
    if (pageOne.rows.some((r) => r.id === s30ThreadId)) {
      throw new Error("the fixture no longer pushes the target thread off page 1 — the smoke proves nothing");
    }
  });

  await expectOk("search finds the off-page conversation by contact name, email, phone and whatsapp value — the whole set, never the loaded page", async () => {
    // The exact legs getConversationList issues: contact name ilike + channel
    // value ilike (email/phone/whatsapp), business-scoped, live rows only,
    // then the thread window filtered by the resolved contact ids.
    const legs = async (q: string) => {
      const names = await db.query<{ id: string }>(
        `select id from public.contacts
         where business_id = $1 and archived_at is null and display_name ilike $2 limit 50`,
        [f.business_id, `%${q}%`]
      );
      const channels = await db.query<{ contact_id: string }>(
        `select contact_id from public.contact_channels
         where business_id = $1 and archived_at is null and channel in ('email', 'phone', 'whatsapp') and value ilike $2 limit 50`,
        [f.business_id, `%${q}%`]
      );
      const idSet = [...new Set([...names.rows.map((r) => r.id), ...channels.rows.map((r) => r.contact_id)])];
      if (idSet.length === 0) return [];
      const windowed = await db.query<{ id: string }>(
        `select id from public.comm_threads
         where business_id = $1 and archived_at is null and last_activity_at is not null and contact_id = any($2::uuid[])
         order by last_activity_at desc limit 20 offset 0`,
        [f.business_id, idSet]
      );
      return windowed.rows.map((r) => r.id);
    };
    for (const [probe, q] of [
      ["name", "Winterbourne"],
      ["email", "wintermail"],
      ["phone", "7700900456"],
      ["whatsapp", "7700900987"],
    ] as const) {
      const found = await legs(q);
      if (!found.includes(s30ThreadId)) throw new Error(`the ${probe} search missed the off-page conversation`);
    }
    // Tripwires: the read layer carries the bounded legs; the page hands the
    // query to the server; the client debounces into the URL instead of
    // filtering the loaded page (the s28-recorded defect).
    const queriesSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/lib/server/queries.ts"),
      "utf8"
    );
    if (!queriesSource.includes("CONVERSATION_SEARCH_BOUND")) {
      throw new Error("getConversationList lost its bounded search legs");
    }
    const clientSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/conversations/conversations-client.tsx"),
      "utf8"
    );
    if (clientSource.includes("t.contactName.toLowerCase().includes")) {
      throw new Error("the conversations search filters the loaded page again — the s28-recorded defect");
    }
    if (!clientSource.includes("router.replace") || !clientSource.includes("setTimeout")) {
      throw new Error("the conversations search is no longer debounced into the URL");
    }
    const pageSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/conversations/page.tsx"),
      "utf8"
    );
    if (!pageSource.includes("getConversationList(Number.isFinite(listPage) ? listPage : 1, q)")) {
      throw new Error("the conversations page no longer hands the query to the server read");
    }
  });

  await expectOk("conversation search never crosses the business wall — RLS holds without the business filter", async () => {
    await db.exec(`set role authenticated`);
    await db.exec(`set request.jwt.claim.sub = '${ids.user}'`);
    // No business_id filter at all: RLS alone must scope every leg.
    const names = await db.query<{ id: string }>(
      `select id from public.contacts where archived_at is null and display_name ilike '%Sadia%'`
    );
    const channels = await db.query<{ contact_id: string }>(
      `select contact_id from public.contact_channels
       where archived_at is null and channel in ('email', 'phone', 'whatsapp') and value ilike '%sadia@%'`
    );
    const contactIds = [...new Set([...names.rows.map((r) => r.id), ...channels.rows.map((r) => r.contact_id)])];
    const threads = contactIds.length
      ? await db.query<{ id: string }>(
          `select id from public.comm_threads
           where archived_at is null and last_activity_at is not null and contact_id = any($1::uuid[])`,
          [contactIds]
        )
      : { rows: [] as { id: string }[] };
    await db.exec(`reset role`);
    const seen = new Set(threads.rows.map((r) => r.id));
    if (!seen.has(s30ThreadId)) throw new Error("the member cannot find their own business's conversation");
    if (seen.has(s30OtherThreadId)) throw new Error("another business's conversation leaked through the search");
  });

  // --- 177a: the gold pending-stamp indicator ----------------------------
  // Back to the trusted-server posture after the RLS probe above.
  await db.exec(`set request.jwt.claim.sub = ''`);
  await db.exec(`set request.jwt.claims = ''`);
  let s30RejectedDraftId = "";
  await expectOk("the gold pending-stamp indicator derives from a pending draft and clears on decision (177a)", async () => {
    const draft = await db.query<{ id: string }>(
      `insert into public.communications (business_id, created_by, thread_id, contact_id, channel, direction, status, body, drafted_by_actor_id)
       values ($1, $2, $3, $4, 'email', 'outbound', 'draft', 'Thank you for your patience. Mudassir will be in touch shortly.', $2) returning id`,
      [f.business_id, f.agent_id, s30ThreadId, s30ContactId]
    );
    const draftId = draft.rows[0]!.id;
    s30RejectedDraftId = draftId;
    await recordCompliance(draftId);
    await db.query(`select public.submit_communication($1, $2)`, [draftId, f.agent_id]);

    // The exact probe getConversationList issues for the row's indicator.
    const pendingProbe = async () =>
      (
        await db.query<{ thread_id: string }>(
          `select thread_id from public.communications
           where thread_id = $1 and direction = 'outbound' and status = 'pending_approval' and archived_at is null`,
          [s30ThreadId]
        )
      ).rows.length;
    if ((await pendingProbe()) !== 1) throw new Error("a submitted draft did not read as awaiting the stamp");

    // The client renders the STATIC gold dot from that fact — beside, never
    // instead of, the accent unread dot (both may coexist, 177a).
    const clientSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/conversations/conversations-client.tsx"),
      "utf8"
    );
    if (!/item\.hasPendingDraft \?[\s\S]{0,400}?bg-gold/.test(clientSource)) {
      throw new Error("the thread row no longer renders the gold pending-stamp dot");
    }
    if (!/item\.unread \?[\s\S]{0,400}?bg-accent/.test(clientSource)) {
      throw new Error("the accent unread dot vanished — 177a keeps both indicators");
    }
    if (/animate|transition/.test(clientSource.match(/aria-label="Draft awaiting your stamp"[\s\S]{0,200}/)?.[0] ?? "")) {
      throw new Error("the pending-stamp dot animates — the thread list is a tier-1 surface and never animates");
    }

    // The decision clears it: a rejection returns the row to draft.
    await db.query(`select public.reject_communication($1, $2, $3)`, [
      draftId,
      f.human_id,
      "Session 30 smoke: rejected to prove the indicator clears.",
    ]);
    if ((await pendingProbe()) !== 0) throw new Error("the indicator did not clear on rejection");
  });

  // --- 177b: the rejected state at both surfaces -------------------------
  await expectOk("a rejected draft renders its rejection at both surfaces — stamp red, recorded reason (177b)", async () => {
    // The 0017 all-or-none triple stands on the row the surfaces read.
    const row = await db.query<{ status: string; rejected_at: string | null; rejection_reason: string | null; rejected_by_actor_id: string | null }>(
      `select status, rejected_at, rejection_reason, rejected_by_actor_id
       from public.communications where id = $1`,
      [s30RejectedDraftId]
    );
    const r = row.rows[0]!;
    if (r.status !== "draft" || !r.rejected_at || !r.rejection_reason || !r.rejected_by_actor_id) {
      throw new Error("the rejection triple is not recorded on the row");
    }
    // The thread window read carries the rejection columns — the bubble
    // cannot tell the truth it cannot see (the s28-class defect).
    const queriesSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/lib/server/queries.ts"),
      "utf8"
    );
    if (!queriesSource.includes("rejected_at, rejected_by_actor_id, rejection_reason")) {
      throw new Error("COMM_WINDOW_COLUMNS no longer selects the rejection triple");
    }
    // Both surfaces render the ruled grammar in the stamp's colour.
    const clientSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/conversations/conversations-client.tsx"),
      "utf8"
    );
    if (!clientSource.includes("Rejected by {message.rejection.byName} · {message.rejection.reason}")) {
      throw new Error("the thread bubble no longer renders the ruled rejection grammar");
    }
    if (!clientSource.includes('message.status === "draft" && message.rejection')) {
      throw new Error("the thread bubble lost its rejected-draft branch");
    }
    const enquirySource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/enquiries/[id]/page.tsx"),
      "utf8"
    );
    if (!enquirySource.includes("Rejected by {comm.rejection.byName} · {comm.rejection.reason}")) {
      throw new Error("the enquiry timeline no longer renders the ruled rejection grammar");
    }
  });

  // --- 177e: the timeline renders newest first, at component level -------
  await expectOk("the enquiry timeline orders newest first — every kind in the one sort, suppressions intact (177e)", async () => {
    const items = buildTimeline({
      stages: [{ id: "s1", label: "Qualified" }],
      events: [
        { occurredAt: "2026-08-01T10:00:00Z", action: "engagement.created" },
        { occurredAt: "2026-08-03T10:00:00Z", action: "light.route_classified" },
        // Suppressed: the message cards tell the comms story.
        { occurredAt: "2026-08-02T10:00:00Z", action: "communication.rejected" },
      ],
      stageHistory: [
        // Suppressed: the opening move is told by engagement.created.
        { movedAt: "2026-08-01T10:00:01Z", fromStageId: null, toStageId: "s1" },
        { movedAt: "2026-08-04T10:00:00Z", fromStageId: "s0", toStageId: "s1" },
      ],
      comms: [
        { occurredAt: "2026-08-02T09:00:00Z", channel: "email" },
        { occurredAt: "2026-08-05T10:00:00Z", channel: "whatsapp" },
        // Suppressed: internal notes render in their own panel.
        { occurredAt: "2026-08-06T10:00:00Z", channel: "internal_note" },
      ],
    });
    const ats = items.map((i) => i.at);
    if (ats.length !== 5) throw new Error(`suppressions broke: ${ats.length} items, expected 5`);
    for (let i = 1; i < ats.length; i++) {
      if (ats[i - 1]! < ats[i]!) throw new Error(`the timeline is not newest-first at index ${i}`);
    }
    if (items[0]!.kind !== "comm" || items[0]!.at !== "2026-08-05T10:00:00Z") {
      throw new Error("the newest item does not lead the timeline");
    }
    if (items[ats.length - 1]!.at !== "2026-08-01T10:00:00Z") {
      throw new Error("the opening event is not at the bottom");
    }
    // No surface renders both orders: the page consumes the ONE pure sort
    // and keeps no ascending compare of its own.
    const enquirySource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/enquiries/[id]/page.tsx"),
      "utf8"
    );
    if (!enquirySource.includes('from "@/lib/enquiry-timeline"')) {
      throw new Error("the enquiry page no longer consumes the pure timeline module");
    }
    if (enquirySource.includes("a.at.localeCompare(b.at)")) {
      throw new Error("the enquiry page regrew an ascending sort beside the newest-first law");
    }
  });

  // --- 177f + 177d: the human stage move and disqualify-cancels-run ------
  const s30Stages = await db.query<{ id: string; key: string }>(
    `insert into public.stage_definitions (engagement_type_id, key, label, sort_order, is_terminal, terminal_outcome)
     values ($1, 'qualified', 'Qualified', 3, false, null),
            ($1, 'disqualified', 'Disqualified', 10, true, 'disqualified')
     returning id, key`,
    [f.type_id]
  );
  const s30QualifiedId = s30Stages.rows.find((r) => r.key === "qualified")!.id;
  const s30DisqualifiedId = s30Stages.rows.find((r) => r.key === "disqualified")!.id;
  const s30Eng = await db.query<{ id: string }>(
    `insert into public.engagements (business_id, created_by, template_type_id, title, stage_id, owner_actor_id)
     values ($1, $2, $3, 'Session 30 stage-control enquiry', $4, $5) returning id`,
    [f.business_id, f.agent_id, f.type_id, f.stage_id, f.human_id]
  );
  const s30EngId = s30Eng.rows[0]!.id;

  await expectOk("a human stage move rides the 0016 door and disqualify CANCELS the live run — mid-flight steps stand down (177f + 177d)", async () => {
    // The active ladder definition (the s26 re-issue) drives a live run.
    const activeDef = await db.query<{ id: string }>(
      `select id from public.workflow_definitions
       where business_id = $1 and key = 'meta_lead_to_consultation' and status = 'active' and archived_at is null
       limit 1`,
      [f.business_id]
    );
    if (!activeDef.rows[0]) throw new Error("no active ladder definition — the fixture moved");
    const run = await db.query<{ id: string }>(
      `select public.start_workflow_run($1, $2, $3) as id`,
      [activeDef.rows[0]!.id, s30EngId, f.agent_id]
    );
    const runId = run.rows[0]!.id;
    const liveSteps = async () =>
      (
        await db.query<{ n: number }>(
          `select count(*)::int as n from public.step_runs
           where run_id = $1 and status in ('scheduled', 'running', 'awaiting_approval')`,
          [runId]
        )
      ).rows[0]!.n;
    if ((await liveSteps()) === 0) throw new Error("the run scheduled no first step — the fixture proves nothing");

    // The human moves the stage — the door records the hand on stage_history.
    await db.query(`select public.move_engagement_stage($1, $2, $3)`, [s30EngId, s30QualifiedId, f.human_id]);
    const lastMove = await db.query<{ actor_type: string }>(
      `select a.actor_type from public.stage_history h join public.actors a on a.id = h.moved_by
       where h.engagement_id = $1 order by h.moved_at desc limit 1`,
      [s30EngId]
    );
    if (lastMove.rows[0]?.actor_type !== "human") {
      throw new Error("the human move is not the engagement's latest recorded stage fact");
    }

    // Disqualify, then cancel the live run exactly as the wrapper does.
    await db.query(`select public.move_engagement_stage($1, $2, $3)`, [s30EngId, s30DisqualifiedId, f.human_id]);
    const eng = await db.query<{ outcome: string | null }>(
      `select outcome from public.engagements where id = $1`,
      [s30EngId]
    );
    if (eng.rows[0]?.outcome !== "disqualified") throw new Error("the terminal move did not record the outcome");
    await db.query(`select public.cancel_workflow_run($1, $2, $3)`, [
      runId,
      f.human_id,
      "enquiry disqualified: smoke reason",
    ]);
    const runRow = await db.query<{ status: string; context: Record<string, unknown> }>(
      `select status, context from public.workflow_runs where id = $1`,
      [runId]
    );
    if (runRow.rows[0]?.status !== "cancelled") throw new Error("the run is not cancelled");
    if (runRow.rows[0]?.context?.cancelled_reason !== "enquiry disqualified: smoke reason") {
      throw new Error("the cancellation reason is not recorded on the run");
    }
    if ((await liveSteps()) !== 0) throw new Error("mid-flight step runs did not stand down with the run");

    // The wrapper wires disqualify → cancel, the action holds the pen, and
    // the control speaks the template's vocabulary (tripwires).
    const workflowSource = readFileSync(resolve(import.meta.dirname, "../src/workflow.ts"), "utf8");
    if (
      !workflowSource.includes("moveEngagementStageAsHuman") ||
      !workflowSource.includes(`terminal_outcome === "disqualified"`) ||
      !workflowSource.includes(`source: "human"`)
    ) {
      throw new Error("moveEngagementStageAsHuman lost its evented disqualify-cancels-run wiring");
    }
    const actionsSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/enquiries/actions.ts"),
      "utf8"
    );
    if (!actionsSource.includes("moveEngagementStageAsHuman")) {
      throw new Error("the enquiry stage action no longer calls the shared wrapper");
    }
    const controlSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/enquiries/stage-control.tsx"),
      "utf8"
    );
    if (!controlSource.includes("stages.map") || !controlSource.includes("disqualified")) {
      throw new Error("the stage control no longer speaks the installed template's vocabulary");
    }
  });

  await expectError("a cancelled run is terminal — it never resumes, no further step can generate a draft", /terminal|paused/, async () => {
    const runId = (
      await db.query<{ id: string }>(
        `select id from public.workflow_runs where engagement_id = $1 limit 1`,
        [s30EngId]
      )
    ).rows[0]!.id;
    await db.query(`select public.resume_workflow_run($1, $2)`, [runId, f.human_id]);
  });

  await expectOk("a machine stage move stands down when the stage was last moved by a human hand (177f)", async () => {
    // The engagement's recorded truth: the latest mover is human (asserted
    // above); the engine consults exactly that fact before moving.
    const engineSource = readFileSync(resolve(import.meta.dirname, "../src/workflow.ts"), "utf8");
    if (!engineSource.includes("human_stage_move_stands")) {
      throw new Error("executeMoveStage lost the 177f stand-down");
    }
    const guardAt = engineSource.indexOf("human_stage_move_stands");
    const before = engineSource.slice(Math.max(0, guardAt - 2000), guardAt);
    if (!before.includes(`from("stage_history")`) || !before.includes(`actor_type === "human"`)) {
      throw new Error("the stand-down no longer reads the engagement's latest stage mover");
    }
    // And the guard sits BEFORE the door call in executeMoveStage.
    const moveAt = engineSource.indexOf("executeMoveStage");
    const rpcAt = engineSource.indexOf(`rpc("move_engagement_stage"`, moveAt);
    if (!(moveAt < guardAt && guardAt < rpcAt)) {
      throw new Error("the stand-down does not precede the machine's stage move");
    }
  });

  // --- 177c: the contact archive ------------------------------------------
  await expectOk("an archived contact leaves resolution and its channels leave consent — history untouched (177c)", async () => {
    const c = await db.query<{ id: string }>(
      `insert into public.contacts (business_id, created_by, type, display_name)
       values ($1, $2, 'person', 'Archie Chamberlain') returning id`,
      [f.business_id, f.agent_id]
    );
    const contactId = c.rows[0]!.id;
    await db.query(
      `insert into public.contact_channels (business_id, created_by, contact_id, channel, value, is_primary, consent)
       values ($1, $2, $3, 'email', 'archie@chamberlain.test', true, '{"transactional": true}'::jsonb),
              ($1, $2, $3, 'phone', '+447700900777', true, '{"transactional": true}'::jsonb)`,
      [f.business_id, f.agent_id, contactId]
    );
    const th = await db.query<{ id: string }>(
      `insert into public.comm_threads (business_id, created_by, contact_id, channel, last_activity_at)
       values ($1, $2, $3, 'email', now()) returning id`,
      [f.business_id, f.agent_id, contactId]
    );
    const threadId = th.rows[0]!.id;
    await db.query(
      `insert into public.communications (business_id, created_by, thread_id, contact_id, channel, direction, status, body)
       values ($1, $2, $3, $4, 'email', 'inbound', 'received', 'Hello, I would like some help please.')`,
      [f.business_id, f.agent_id, threadId, contactId]
    );

    // BEFORE: the resolver's own query finds the contact; consent holds.
    const resolverRows = async () =>
      (
        await db.query<{ contact_id: string; channel: string; value: string }>(
          `select contact_id, channel, value from public.contact_channels
           where business_id = $1 and channel in ('email', 'phone')
             and value in ('archie@chamberlain.test', '+447700900777')
             and archived_at is null`,
          [f.business_id]
        )
      ).rows;
    const before = resolveKnownContactId(await resolverRows(), "archie@chamberlain.test", "+447700900777");
    if (before !== contactId) throw new Error("the live contact did not resolve — the fixture proves nothing");
    const consentCheck = async () => {
      const r = await db.query<{ out: { checks: Array<{ key: string; pass: boolean }> } }>(
        `select private.comm_preflight($1, $2, 'email', 'Thank you for your message.', null, '{}'::jsonb, false) as out`,
        [f.business_id, contactId]
      );
      return r.rows[0]!.out.checks.find((ch) => ch.key === "consent")!;
    };
    if (!(await consentCheck()).pass) throw new Error("consent did not hold before the archive");

    // The archive, exactly as archiveContact performs it: the contact and
    // every live channel row stamp archived_at; nothing is deleted.
    await db.query(
      `update public.contacts set archived_at = now() where id = $1 and archived_at is null`,
      [contactId]
    );
    await db.query(
      `update public.contact_channels set archived_at = now() where contact_id = $1 and archived_at is null`,
      [contactId]
    );

    // AFTER: resolution finds no one; consent refuses; history stands.
    const after = resolveKnownContactId(await resolverRows(), "archie@chamberlain.test", "+447700900777");
    if (after !== null) throw new Error("an archived contact still resolves — 177c broken");
    if ((await consentCheck()).pass) throw new Error("an archived contact's channels still hold consent");
    const history = await db.query<{ contact: number; thread: number; comm: number }>(
      `select
         (select count(*)::int from public.contacts where id = $1) as contact,
         (select count(*)::int from public.comm_threads where id = $2) as thread,
         (select count(*)::int from public.communications where thread_id = $2) as comm`,
      [contactId, threadId]
    );
    const h = history.rows[0]!;
    if (h.contact !== 1 || h.thread !== 1 || h.comm !== 1) {
      throw new Error("archive touched history — a row vanished");
    }

    // The render/act truth and the wrapper's wiring (tripwires).
    if (!canArchiveContact({ isOwner: true, alreadyArchived: false })) {
      throw new Error("the owner cannot archive a live contact");
    }
    if (canArchiveContact({ isOwner: false, alreadyArchived: false })) {
      throw new Error("a non-owner may archive — owner-only for now (177c)");
    }
    if (canArchiveContact({ isOwner: true, alreadyArchived: true })) {
      throw new Error("an archived contact re-archives — the control must not render");
    }
    const kinds = readFileSync(resolve(import.meta.dirname, "../src/event-kinds.ts"), "utf8");
    if (!kinds.includes('"contact.archived"')) {
      throw new Error("the contact.archived event kind is gone from the registry");
    }
    const contactsSource = readFileSync(resolve(import.meta.dirname, "../src/contacts.ts"), "utf8");
    if (!contactsSource.includes("CONTACT_EVENT_KINDS.archived") || !contactsSource.includes("contact_channels")) {
      throw new Error("archiveContact no longer events the act or no longer cascades to the channels");
    }
    const archiveActionSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/contacts/actions.ts"),
      "utf8"
    );
    if (!archiveActionSource.includes("canArchiveContact") || !archiveActionSource.includes('membershipRole === "owner"')) {
      throw new Error("the archive action lost its owner gate");
    }
  });

  // --- Workstream C: archive lands on the book, never the archived page --
  await expectOk("archive redirects to the Contacts book with its confirmation — and the book offers no door to an archived contact (WS C)", async () => {
    // The one redirect target, proven as the action computes it.
    if (archivedContactRedirect("Archie Chamberlain") !== "/contacts?archived=Archie%20Chamberlain") {
      throw new Error("the archive redirect target moved");
    }
    // The action redirects SERVER-side with that target — the archived
    // page (an honest 404 once the read layer refuses the row) is never
    // reloaded; the client-side push that raced into the 404 is gone.
    const actionSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/contacts/actions.ts"),
      "utf8"
    );
    if (!actionSource.includes("redirect(archivedContactRedirect(")) {
      throw new Error("the archive action no longer redirects to the book");
    }
    const controlSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/contacts/[id]/archive-control.tsx"),
      "utf8"
    );
    if (controlSource.includes("router.push")) {
      throw new Error("the archive control regrew the client-side race the founder witnessed as a 404");
    }
    // The book renders the once-per-event confirmation from the redirect's
    // own param, in the shipped toast pattern — static, never animated.
    const pageSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/contacts/page.tsx"),
      "utf8"
    );
    if (!pageSource.includes("ArchivedToast")) {
      throw new Error("the Contacts book lost the archive confirmation");
    }
    const toastSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/contacts/archived-toast.tsx"),
      "utf8"
    );
    if (!toastSource.includes("Archived · on The Record")) {
      throw new Error("the confirmation lost its ruled wording");
    }
    if (toastSource.includes("animate-") || toastSource.includes("transition")) {
      throw new Error("the confirmation animates — the shipped toast pattern is static");
    }
    // No door from the book: the archived contact answers none of the
    // book's own reads — the live set, nor the search legs.
    const inBook = await db.query<{ n: number }>(
      `select count(*)::int as n from public.contacts
       where business_id = $1 and archived_at is null and display_name = 'Archie Chamberlain'`,
      [f.business_id]
    );
    if (inBook.rows[0]!.n !== 0) throw new Error("the archived contact still stands in the book's set");
    const legs = await db.query<{ n: number }>(
      `select count(*)::int as n from public.contact_channels
       where business_id = $1 and archived_at is null
         and value in ('archie@chamberlain.test', '+447700900777')`,
      [f.business_id]
    );
    if (legs.rows[0]!.n !== 0) {
      throw new Error("the archived contact's channels still answer the book's search legs");
    }
    // The list renders only the rows the server handed it — no client-side
    // set that could resurrect a link.
    const listSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/contacts/contacts-list.tsx"),
      "utf8"
    );
    if (!listSource.includes("const visible = contacts;")) {
      throw new Error("the list renders rows the server did not hand it");
    }
  });

  // ---------------------------------------------------------------------
  // Session 31 — drafting quality (D179): fees out of machine drafts,
  // nudges compose as follow-ups, retrieval and attachments follow the
  // resolved route.
  // ---------------------------------------------------------------------
  console.log("\nSession 31 — drafting quality (D179):");

  await expectOk("the currency-amount screen is a lookup that NAMES the match — symbols, codes and currency words beside digits; clean prose passes", async () => {
    if (findFeeBreach("The consultation is £150.") !== "£150") throw new Error("a pound amount slipped through");
    if (findFeeBreach("From £1,500.50 for the full service.") !== "£1,500.50") throw new Error("a formatted amount slipped");
    if (findFeeBreach("That will be GBP 200 please") === null) throw new Error("a currency code slipped");
    if (findFeeBreach("about 150 pounds all in") === null) throw new Error("a currency word slipped");
    if (findFeeBreach("costs $99.99 to file") === null) throw new Error("a dollar amount slipped");
    for (const clean of [
      "Hello Amina, thank you for your enquiry. If you would like to speak to our legal team, the next step is booking a consultation.",
      "The financial requirement asks the sponsor to evidence a minimum income above a set threshold.",
      "You can reach us on +44 7700 900123 whenever suits you.",
      "Fees are discussed at the consultation.",
    ]) {
      const hit = findFeeBreach(clean);
      if (hit !== null) throw new Error(`clean prose was refused: "${hit}"`);
    }
  });

  await expectOk("both generation prompts FORBID fees and invite the next step instead (D179a) — the belt on both compose paths", async () => {
    let sawSystem = "";
    const fake: GenerateFn = async (request) => {
      sawSystem = request.system;
      return {
        subject: null,
        body: "Hello Amina, thank you for your message. We can help with that.",
        attestation: { attested: true, statement: "Complies." },
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    };
    await composeDraft(fake, s18Input("intro"));
    if (!sawSystem.includes(FEE_PROHIBITION_LINE)) throw new Error("the intro/nudge prompt lost the fee prohibition");
    await composeDraft(fake, { ...s18Input("nudge"), prior_sends: [{ at: "2026-08-05", channel: "email", summary: "Your enquiry with Test Firm" }] });
    if (!sawSystem.includes(FEE_PROHIBITION_LINE)) throw new Error("the nudge prompt lost the fee prohibition");
    const { systemBlocks } = assembleReplyPrompt(s16ReplyInput);
    if (!systemBlocks[0]!.text.includes(FEE_PROHIBITION_LINE)) throw new Error("the reply prompt lost the fee prohibition");
    if (/does not appear verbatim in the provided published knowledge/.test(sawSystem + systemBlocks[0]!.text)) {
      throw new Error("the old published-fee allowance still rides a prompt — D179a is absolute");
    }
  });

  await expectOk("a generated body carrying a fee is REFUSED with the match named, and takes the register retry-once lane (both paths)", async () => {
    let attempts = 0;
    let sawFeedback: string | undefined;
    const slipsOnce: GenerateFn = async (request) => {
      attempts += 1;
      sawFeedback = /compliance screen: (.*)$/m.exec(request.prompt)?.[1];
      return {
        subject: null,
        body:
          attempts === 1
            ? "Hello Amina, a consultation is £150 and we would be glad to help."
            : "Hello Amina, if you would like to speak to our legal team, the next step is booking a consultation.",
        attestation: { attested: true, statement: "x" },
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    };
    const { composed, registerRetried } = await composeWithRegisterRetry(
      (inp, opts) => composeDraft(slipsOnce, inp, opts),
      s18Input("intro"),
      async (breach) => {
        if (breach.breach !== "currency amount") throw new Error(`breach kind: ${breach.breach}`);
        if (!/"£150"/.test(breach.message)) throw new Error("the refusal did not NAME the match");
      }
    );
    if (!registerRetried || attempts !== 2) throw new Error("the fee breach did not take the retry-once lane");
    if (!/£150/.test(sawFeedback ?? "")) throw new Error("the violation was not fed back into the regeneration");
    if (findFeeBreach(composed.body) !== null) throw new Error("the standing body still carries a fee");
    if (composed.usage.input_tokens !== 20) throw new Error("the refused attempt's tokens were not metered");
    // The reply path refuses the same way.
    const feeReply: GenerateFn = async () => ({
      subject: null,
      body: "Hello Amina, our fee is 500 pounds.",
      attestation: { attested: true, statement: "x" },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    let threw = false;
    try {
      await composeReplyDraft(feeReply, s16ReplyInput);
    } catch (err) {
      threw = err instanceof RegisterBreachError && err.breach === "currency amount" && /"500 pounds"/.test(err.message);
    }
    if (!threw) throw new Error("a fee survived reply composition");
  });

  await expectOk("the templates carry no figure (D179a sweep, pinned): every harness template row and every seed template body is currency-free", async () => {
    // The harness DB's rows — body, subject and every per-channel body.
    const rows = await db.query<{ body: string; subject: string | null; attributes: Record<string, unknown> | null }>(
      `select body, subject, attributes from public.message_templates`
    );
    for (const row of rows.rows) {
      for (const text of [
        row.body,
        row.subject ?? "",
        ...Object.values((row.attributes?.bodies as Record<string, string> | undefined) ?? {}),
      ]) {
        const hit = findFeeBreach(text);
        if (hit) throw new Error(`a template body carries "${hit}" — templates carry no figure (D179a)`);
      }
    }
    // The seed's TEMPLATES block (the founder-approved copy, including the
    // Meta-approved WhatsApp bodies recorded verbatim) — swept at source so
    // a future fee-bearing edit fails here before it ever installs.
    const seedSource = readFileSync(resolve(import.meta.dirname, "../seed/index.ts"), "utf8");
    const start = seedSource.indexOf("const TEMPLATES = [");
    const end = seedSource.indexOf("] as const;", start);
    if (start === -1 || end === -1) throw new Error("the seed's TEMPLATES block moved — re-point the sweep");
    const hit = findFeeBreach(seedSource.slice(start, end));
    if (hit) throw new Error(`a seed template carries "${hit}" — templates carry no figure (D179a)`);
  });

  await expectOk("a nudge composes as a FOLLOW-UP (D179b): what was already sent rides the prompt, no re-introduction, shorter than the intro", async () => {
    let sawSystem = "";
    let sawPrompt = "";
    const fake: GenerateFn = async (request) => {
      sawSystem = request.system;
      sawPrompt = request.prompt;
      return {
        subject: null,
        body: "Hello Amina, just a short note to say your enquiry is still open with us.",
        attestation: { attested: true, statement: "Complies." },
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    };
    const priorSends = [
      { at: "2026-08-04", channel: "email", summary: "Your enquiry with Test Firm" },
      { at: "2026-08-05", channel: "whatsapp", summary: "Hello Amina, thank you for your enquiry with X Law." },
    ];
    await composeDraft(fake, { ...s18Input("nudge"), prior_sends: priorSends });
    if (!/FOLLOW-UP, not a first contact/.test(sawSystem)) throw new Error("the follow-up register left the nudge prompt");
    if (!/Never re-introduce the firm/.test(sawSystem)) throw new Error("the no-re-introduction instruction is missing");
    if (!/SHORTER than a first reply/.test(sawSystem)) throw new Error("the shorter-than-the-intro instruction is missing");
    if (!/Acknowledge in one natural phrase that we wrote before/.test(sawSystem)) {
      throw new Error("the acknowledge-we-wrote-before instruction is missing");
    }
    if (!/Already sent to this enquirer/.test(sawPrompt) || !/2026-08-04 · email/.test(sawPrompt)) {
      throw new Error("the prior-sends summary did not reach the prompt");
    }
    // An intro is not a follow-up: none of the nudge register rides it.
    await composeDraft(fake, s18Input("intro"));
    if (/FOLLOW-UP, not a first contact/.test(sawSystem)) throw new Error("the follow-up register leaked into the intro");
    // Honesty: a nudge with NOTHING genuinely sent never claims we wrote
    // before — the no-cold-open and shorter lines still bind.
    await composeDraft(fake, s18Input("nudge"));
    if (/Acknowledge in one natural phrase that we wrote before/.test(sawSystem)) {
      throw new Error("a nudge with no prior sends still claims the firm wrote before");
    }
    if (!/Never re-introduce the firm/.test(sawSystem)) throw new Error("the no-re-introduction line must bind every nudge");
    // The workflow drafter feeds the summary from genuinely sent outbound
    // rows, engagement-wide (the ladder crosses channels).
    const workflowSource = readFileSync(resolve(import.meta.dirname, "../src/workflow.ts"), "utf8");
    if (!workflowSource.includes(`"prior sends lookup"`) || !workflowSource.includes('in("status", ["sent", "delivered", "read"])')) {
      throw new Error("the nudge composer no longer reads what was genuinely sent");
    }
    if (!workflowSource.includes("prior_sends: priorSends")) {
      throw new Error("the prior-sends summary no longer reaches nudge composition");
    }
  });

  await expectOk("the DoD route walk, pure: ILR words through the spouse form resolve to ILR (light) — ILR copy, no spouse booklet; ambiguous resolves to nothing — no booklet at all", async () => {
    const options = [
      { key: "spouse_family", label: "Spouse/Family" },
      { key: "ilr", label: "ILR" },
    ];
    const pack: KnowledgeEntry[] = [
      { id: "sp", title: "Spouse", category: "service_description", visa_route: "spouse_family", text: "Spouse route." },
      { id: "ilr", title: "ILR", category: "service_description", visa_route: "ilr", text: "ILR route." },
    ];
    const guides = [
      { id: "g-sp", title: "Spouse Guide", attributes: { visa_route: "spouse_family" }, created_at: "2026-01-01" },
      { id: "g-ilr", title: "ILR Guide", attributes: { visa_route: "ilr" }, created_at: "2026-01-01" },
    ];
    // The confident read over the form_default source: ILR wins.
    const confident: ClassifyFn = async () => ({
      key: "ilr",
      reason: "the form and enquiry text ask about indefinite leave, not a spouse application",
      usage: { input_tokens: 30, output_tokens: 10 },
    });
    const read = await classifyRoute(confident, {
      enquiry_title: "Bilal Hussain — enquiry",
      form_label: "Spouse Visa 23/04/2024",
      form_answers: [{ name: "q", label: "Question", value: "I have held a skilled worker visa five years and want ILR" }],
      options,
    });
    if (read.key !== "ilr") throw new Error("the confident ILR read did not survive");
    const ids = selectKnowledgeEntries(pack, "I want ILR", read.key).entries.map((e) => e.id);
    if (!ids.includes("ilr") || ids.includes("sp")) throw new Error("retrieval did not follow the resolved route");
    const ranked = rankGuideCandidates(guides, [read.key]);
    if (ranked.length !== 1 || ranked[0]!.route !== "ilr") throw new Error("the booklet did not follow the resolved route");
    // Genuinely ambiguous, no default: the honest null — nothing
    // route-specific attaches (a missing booklet is recoverable).
    const abstains: ClassifyFn = async () => ({
      key: null,
      reason: "the form answers name no route and the enquiry is generic",
      usage: { input_tokens: 30, output_tokens: 10 },
    });
    const noRead = await classifyRoute(abstains, { enquiry_title: "General enquiry", form_answers: [], options });
    if (noRead.key !== null) throw new Error("an unconfident read produced a route");
    if (rankGuideCandidates(guides, []).length !== 0) throw new Error("an unresolved route still ranked a booklet");
    if (selectKnowledgeEntries(pack, "help me with my visa please", null).entries.length !== 0) {
      throw new Error("an unresolved route still pulled route-specific copy");
    }
  });

  // ---------------------------------------------------------------------
  // Session 32 — Light's Memory (D181): memory entries, the 800-token
  // ceiling, human-only instructions, the append-only supersede chain, the
  // ripple sweep's pure planner, and the memory-riding compose paths.
  // ---------------------------------------------------------------------
  console.log("\nSession 32 — Light's Memory (D181):");

  await expectOk("a memory entry's content is append-only — an edit supersedes, never overwrites; deletion does not exist", async () => {
    const row = await db.query<{ id: string }>(
      `insert into public.memory_entries (business_id, created_by, kind, title, body)
       values ($1, $2, 'observation', 'Test observation', 'Clients prefer short replies.') returning id`,
      [f.business_id, f.agent_id]
    );
    const id = row.rows[0]!.id;
    let threw = false;
    try {
      await db.query(`update public.memory_entries set body = 'rewritten' where id = $1`, [id]);
    } catch (err) {
      threw = /append-only/.test(String(err));
    }
    if (!threw) throw new Error("a body rewrite was not refused");
    try {
      await db.query(`delete from public.memory_entries where id = $1`, [id]);
      throw new Error("DELETE was not refused");
    } catch (err) {
      if (!/append-only/.test(String(err))) throw err;
    }
    const still = await db.query<{ body: string }>(`select body from public.memory_entries where id = $1`, [id]);
    if (still.rows[0]!.body !== "Clients prefer short replies.") throw new Error("the entry changed");
  });

  await expectOk("the supersede transition is the ONE lawful update — chained once, never rewritten, never reactivated", async () => {
    const e1 = await db.query<{ id: string }>(
      `insert into public.memory_entries (business_id, created_by, kind, title, body, attributes)
       values ($1, $2, 'fact', 'Test fact', 'old value', '{"fact_key":"s32_chain"}'::jsonb) returning id`,
      [f.business_id, f.human_id]
    );
    const e2 = await db.query<{ id: string }>(
      `insert into public.memory_entries (business_id, created_by, kind, title, body, attributes)
       values ($1, $2, 'fact', 'Test fact', 'new value', '{"fact_key":"s32_chain_next"}'::jsonb) returning id`,
      [f.business_id, f.human_id]
    );
    // The lawful flip: active -> false with the successor named, once.
    await db.query(
      `update public.memory_entries set active = false, superseded_by_entry_id = $2 where id = $1`,
      [e1.rows[0]!.id, e2.rows[0]!.id]
    );
    for (const [label, sql, pattern] of [
      // Re-chaining means pointing at a DIFFERENT successor — the chain
      // never rewrites once set (same-value writes are no-ops).
      ["re-chain", `update public.memory_entries set superseded_by_entry_id = '${e1.rows[0]!.id}' where id = '${e1.rows[0]!.id}'`, /already superseded/],
      ["reactivate", `update public.memory_entries set active = true where id = '${e1.rows[0]!.id}'`, /cannot reactivate/],
    ] as const) {
      try {
        await db.query(sql);
        throw new Error(`${label} was not refused`);
      } catch (err) {
        if (!pattern.test(String(err))) throw new Error(`${label}: wrong error: ${err}`);
      }
    }
  });

  await expectOk("Light never self-writes an instruction — the database refuses a non-human author; a human hand passes", async () => {
    try {
      await db.query(
        `insert into public.memory_entries (business_id, created_by, kind, title, body)
         values ($1, $2, 'instruction', 'Self-written', 'I will do as I please.')`,
        [f.business_id, f.agent_id]
      );
      throw new Error("an agent-authored instruction was not refused");
    } catch (err) {
      if (!/HUMAN hand/.test(String(err))) throw err;
    }
    const none = await db.query<{ n: number }>(
      `select count(*)::int as n from public.memory_entries where business_id = $1 and title = 'Self-written'`,
      [f.business_id]
    );
    if (none.rows[0]!.n !== 0) throw new Error("the refused instruction landed anyway");
    await db.query(
      `insert into public.memory_entries (business_id, created_by, kind, title, body, attributes)
       values ($1, $2, 'instruction', 'Human-written', 'Always be brief.', '{"instruction_key":"s32_brief"}'::jsonb)`,
      [f.business_id, f.human_id]
    );
  });

  await expectOk("the ceiling refuses at 801, NAMING the count — and 800 exactly still passes (D181)", async () => {
    // 'Always be brief.' above = 4 tokens. Fill to 700 with one big body,
    // then attempt the token that crosses.
    const big = "x".repeat(4 * 696); // 696 tokens -> total 700
    const bigRow = await db.query<{ id: string }>(
      `insert into public.memory_entries (business_id, created_by, kind, title, body)
       values ($1, $2, 'instruction', 'Big', $3) returning id`,
      [f.business_id, f.human_id, big]
    );
    try {
      await db.query(
        `insert into public.memory_entries (business_id, created_by, kind, title, body)
         values ($1, $2, 'instruction', 'One over', $3)`,
        [f.business_id, f.human_id, "y".repeat(4 * 101)] // 101 -> 801
      );
      throw new Error("the 801st token was not refused");
    } catch (err) {
      const message = String(err);
      if (!/801 tokens/.test(message) || !/ceiling is 800/.test(message)) {
        throw new Error(`the refusal did not name the count: ${message}`);
      }
    }
    const exact = await db.query<{ id: string }>(
      `insert into public.memory_entries (business_id, created_by, kind, title, body)
       values ($1, $2, 'instruction', 'Exactly at cap', $3) returning id`,
      [f.business_id, f.human_id, "z".repeat(4 * 100)] // 100 -> 800 exactly
    );
    // The TS mirror agrees with the trigger's arithmetic, token for token.
    if (memoryInstructionTokens([big, "z".repeat(4 * 100), "Always be brief."]) !== 800) {
      throw new Error("estimateTokens and the trigger disagree");
    }
    if (MEMORY_INSTRUCTION_TOKEN_CEILING !== 800) throw new Error("the ceiling constant moved off the ruled 800");
    // Leave the field clean for later smokes: retire the fillers.
    await db.query(`update public.memory_entries set active = false where id = $1`, [bigRow.rows[0]!.id]);
    await db.query(`update public.memory_entries set active = false where id = $1`, [exact.rows[0]!.id]);
  });

  await expectOk("one ACTIVE fact per key per business — two homes are the drift the laws forbid; a retired key can be re-added", async () => {
    await db.query(
      `insert into public.memory_entries (business_id, created_by, kind, title, body, attributes)
       values ($1, $2, 'fact', 'Booking link', 'https://xlaw.example/book', '{"fact_key":"s32_booking"}'::jsonb)`,
      [f.business_id, f.human_id]
    );
    try {
      await db.query(
        `insert into public.memory_entries (business_id, created_by, kind, title, body, attributes)
         values ($1, $2, 'fact', 'Booking link', 'https://elsewhere.example', '{"fact_key":"s32_booking"}'::jsonb)`,
        [f.business_id, f.human_id]
      );
      throw new Error("a second active fact under the same key was not refused");
    } catch (err) {
      if (!/duplicate|unique/i.test(String(err))) throw err;
    }
    await db.query(
      `update public.memory_entries set active = false
       where business_id = $1 and attributes ->> 'fact_key' = 's32_booking'`,
      [f.business_id]
    );
    await db.query(
      `insert into public.memory_entries (business_id, created_by, kind, title, body, attributes)
       values ($1, $2, 'fact', 'Booking link', 'https://new.example/book', '{"fact_key":"s32_booking"}'::jsonb)`,
      [f.business_id, f.human_id]
    );
  });

  await expectOk("cross-tenant invisibility: a member of business A sees zero memory of business B; users hold no DELETE", async () => {
    const other = await db.query<{ business_id: string }>(
      `with acc as (
        insert into public.accounts (name, signup_business_name, signup_email) values ('Other Memory Firm', 'Other Memory Firm', 'other-mem@example.test') returning id
      ), biz as (
        insert into public.businesses (account_id, name) select id, 'Other Memory Firm' from acc returning id, account_id
      ), actor as (
        insert into public.actors (account_id, actor_type, display_name) select account_id, 'human', 'Other Human' from biz returning id
      )
      select (select id from biz) as business_id, (select id from actor) as actor_id`
    );
    await db.query(
      `insert into public.memory_entries (business_id, created_by, kind, title, body)
       values ($1, (select id from public.actors where account_id = (select account_id from public.businesses where id = $1) limit 1), 'observation', 'Their secret', 'Other firm memory')`,
      [other.rows[0]!.business_id]
    );
    await db.exec(`set role authenticated`);
    await db.exec(`set request.jwt.claim.sub = '${ids.user}'`);
    const seen = await db.query<{ n: number }>(
      `select count(*)::int as n from public.memory_entries where business_id = $1`,
      [other.rows[0]!.business_id]
    );
    if (seen.rows[0]!.n !== 0) throw new Error("another business's memory is visible");
    const mine = await db.query<{ n: number }>(
      `select count(*)::int as n from public.memory_entries where business_id = $1`,
      [f.business_id]
    );
    if (mine.rows[0]!.n === 0) throw new Error("the member cannot read their own business's memory");
    try {
      await db.query(`delete from public.memory_entries where business_id = $1`, [f.business_id]);
      throw new Error("a user DELETE was not refused");
    } catch (err) {
      if (!/permission denied|append-only/.test(String(err))) throw err;
    }
    await db.exec(`reset role`);
  });

  await expectOk("an instruction edit changes the NEXT draft, the entry named on the credit line (both compose paths)", async () => {
    let sawSystem = "";
    const fake: GenerateFn = async (request) => {
      sawSystem = request.system;
      return {
        subject: null,
        body: "Hello Amina, thank you for your message. We can help with that.",
        attestation: { attested: true, statement: "Complies." },
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    };
    const v1: MemoryContext = {
      instructions: [...seededMemory.instructions, { id: "mem-wa-1", body: "Always mention free parking." }],
      facts: [],
    };
    const before = await composeDraft(fake, { ...s18Input("intro"), memory: v1 });
    if (!sawSystem.includes("Always mention free parking.")) throw new Error("the instruction did not ride the draft");
    if (!before.credit_line.memory_entry_ids.includes("mem-wa-1")) {
      throw new Error("the credit line does not name the riding entry");
    }
    // The edit: a superseding entry (new id, new wording) — the next draft
    // obeys the successor and names IT, never the predecessor.
    const v2: MemoryContext = {
      instructions: [
        ...seededMemory.instructions,
        { id: "mem-wa-2", body: "Always offer WhatsApp as an alternative way to continue the conversation." },
      ],
      facts: [],
    };
    const after = await composeDraft(fake, { ...s18Input("intro"), memory: v2 });
    if (!sawSystem.includes("Always offer WhatsApp as an alternative")) throw new Error("the edited instruction did not ride");
    if (sawSystem.includes("Always mention free parking.")) throw new Error("the superseded wording still rides");
    if (!after.credit_line.memory_entry_ids.includes("mem-wa-2") || after.credit_line.memory_entry_ids.includes("mem-wa-1")) {
      throw new Error("the credit line does not name the successor by id");
    }
    // The reply path carries instructions in the CACHED laws block.
    const { systemBlocks } = assembleReplyPrompt({ ...s16ReplyInput, memory: v2 });
    if (!systemBlocks[0]!.text.includes("Always offer WhatsApp as an alternative")) {
      throw new Error("the reply path lost the instruction");
    }
  });

  await expectOk("facts ride both compose paths, stated exactly, named on the credit line; empty memory rides nothing", async () => {
    let sawSystem = "";
    const fake: GenerateFn = async (request) => {
      sawSystem = request.system;
      return {
        subject: null,
        body: "Hello Amina, thank you for your message. We can help with that.",
        attestation: { attested: true, statement: "Complies." },
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    };
    const withFacts: MemoryContext = {
      instructions: seededMemory.instructions,
      facts: [{ id: "mem-hours", key: "opening_hours", title: "Opening hours", body: "09:00 to 17:00 (Europe/London)" }],
    };
    const composed = await composeDraft(fake, { ...s18Input("intro"), memory: withFacts });
    if (!sawSystem.includes("Opening hours: 09:00 to 17:00 (Europe/London)")) {
      throw new Error("the fact did not ride the draft");
    }
    if (!composed.credit_line.memory_entry_ids.includes("mem-hours")) {
      throw new Error("the fact is not named on the credit line");
    }
    const { systemBlocks } = assembleReplyPrompt({ ...s16ReplyInput, memory: withFacts });
    if (!systemBlocks[1]!.text.includes("Opening hours: 09:00 to 17:00")) {
      throw new Error("the reply path's knowledge block lost the facts");
    }
    if (memoryInstructionLines(null).length !== 0 || memoryFactLines({ instructions: [], facts: [] }).length !== 0) {
      throw new Error("empty memory added prompt lines");
    }
  });

  await expectOk("Memory is the single home (Q1 option A): sign-off and booking link resolve memory-first, settings only as the transitional fallback", async () => {
    const memory: MemoryContext = {
      instructions: [],
      facts: [
        { id: "sig", key: "signature", title: "Signature", body: "X Law Client Team" },
        { id: "book", key: "booking_link", title: "Booking link", body: "https://xlaw.example/book-now" },
      ],
    };
    const settings = { email_sign_off: "Old Sign-off", booking_url: "https://old.example/book" };
    if (resolveSignOffWithMemory(memory, settings, "X Law") !== "X Law Client Team") {
      throw new Error("the memory signature did not win");
    }
    if (resolveSignOffWithMemory({ instructions: [], facts: [] }, settings, "X Law") !== "Old Sign-off") {
      throw new Error("the transitional settings fallback is dead before the seed");
    }
    if (resolveSignOffWithMemory(null, {}, "X Law") !== "X Law") throw new Error("the firm-name default fell");
    if (resolveBookingUrlWithMemory(memory, settings) !== "https://xlaw.example/book-now") {
      throw new Error("the memory booking link did not win");
    }
    const badMemory: MemoryContext = {
      instructions: [],
      facts: [{ id: "book", key: "booking_link", title: "Booking link", body: "not a url" }],
    };
    if (resolveBookingUrlWithMemory(badMemory, settings) !== "https://old.example/book") {
      throw new Error("an invalid memory value did not fall through honestly");
    }
    if (resolveBookingUrlWithMemory(null, {}) !== null) throw new Error("no home still produced a link");
    if (memoryFactValue(memory, "signature") !== "X Law Client Team") throw new Error("memoryFactValue misread");
  });

  await expectOk("the ripple sweep plans the DoD walk, pure: a correction per in-platform carrier, a task per external surface, fail-loud on not-found, website deferred — deterministic substitution only", async () => {
    const carriers: SweepCarrier[] = [
      {
        decl: { surface: "knowledge_entry", label: "Consultation booking policy", ref: "ci-1", in_platform: true },
        entry: {
          id: "ci-1",
          title: "Consultation booking policy",
          version: 3,
          body: [
            { type: "paragraph", text: "We are open 09:00 to 17:00 (Europe/London)." },
            { type: "paragraph", text: "Book through the website." },
          ],
        },
      },
      {
        decl: { surface: "message_template", label: "Template: intro_email", ref: "intro_email", in_platform: true },
        template: {
          id: "mt-1",
          key: "intro_email",
          channel: "email",
          subject: null,
          body: "Hello {{first_name}}, our office hours are 09:00 to 17:00 (Europe/London).",
          version: 2,
        },
      },
      { decl: { surface: "google_business_profile", label: "Google Business Profile", ref: null, in_platform: false } },
      {
        decl: { surface: "knowledge_entry", label: "Spouse route", ref: "ci-2", in_platform: true },
        entry: { id: "ci-2", title: "Spouse route", version: 1, body: [{ type: "paragraph", text: "No hours here." }] },
      },
      { decl: { surface: "website", label: "Website", ref: null, in_platform: true } },
    ];
    const plan = planFactSweep({
      fact_title: "Opening hours",
      old_value: "09:00 to 17:00 (Europe/London)",
      new_value: "10:00 to 16:00 (Europe/London)",
      carriers,
    });
    if (plan.corrections.length !== 2) throw new Error(`expected 2 corrections, got ${plan.corrections.length}`);
    const knowledge = plan.corrections.find((c) => c.content_type === "knowledge_entry_correction")!;
    if (!/10:00 to 16:00/.test(knowledge.body_after_text) || /09:00 to 17:00/.test(knowledge.body_after_text)) {
      throw new Error("the knowledge substitution is not deterministic old->new");
    }
    const blocksAfter = knowledge.correction.blocks_after as Array<{ text: string }>;
    if (blocksAfter.length !== 2 || blocksAfter[1]!.text !== "Book through the website.") {
      throw new Error("the entry's block shape did not survive the correction");
    }
    const template = plan.corrections.find((c) => c.content_type === "template_correction")!;
    if (!/\{\{first_name\}\}, our office hours are 10:00 to 16:00/.test(String(template.correction.body_after))) {
      throw new Error("the template substitution went wrong");
    }
    if (plan.tasks.length !== 2) throw new Error(`expected 2 tasks, got ${plan.tasks.length}`);
    const external = plan.tasks.find((t) => t.reason === "external")!;
    if (!/Google Business Profile/.test(external.title) || !/owed by hand/.test(external.description)) {
      throw new Error("the external task does not name the owed change");
    }
    const notFound = plan.tasks.find((t) => t.reason === "value_not_found")!;
    if (!/Spouse route/.test(notFound.title) || !/not found verbatim/.test(notFound.description)) {
      throw new Error("the not-found surface did not fail loud");
    }
    if (plan.deferred.length !== 1 || plan.deferred[0] !== "Website") throw new Error("the website surface did not defer");
    // No change, no sweep; a first value (no old) sweeps nothing.
    if (planFactSweep({ fact_title: "x", old_value: "same", new_value: "same", carriers }).corrections.length !== 0) {
      throw new Error("an unchanged value swept");
    }
    if (planFactSweep({ fact_title: "x", old_value: "", new_value: "fresh", carriers }).corrections.length !== 0) {
      throw new Error("a first value swept");
    }
  });

  await expectOk("nothing auto-applies: a sweep correction is born pending_approval and only a HUMAN publisher can stamp it; retrieval never reads it", async () => {
    const correction = await db.query<{ id: string }>(
      `insert into public.content_items (business_id, created_by, content_type, title, slug, body, visibility, state, attributes)
       values ($1, $2, 'template_correction', 'Correction: intro_email — Opening hours', 's32-corr-1', '[]'::jsonb, 'team', 'pending_approval',
               '{"correction":{"surface":"message_template"}}'::jsonb) returning id`,
      [f.business_id, f.agent_id]
    );
    try {
      await db.query(
        `update public.content_items set state = 'published', published_by_actor_id = $2, published_at = now() where id = $1`,
        [correction.rows[0]!.id, f.agent_id]
      );
      throw new Error("an agent stamped a correction");
    } catch (err) {
      if (!/HUMAN/.test(String(err))) throw err;
    }
    const pending = await db.query<{ state: string }>(`select state from public.content_items where id = $1`, [
      correction.rows[0]!.id,
    ]);
    if (pending.rows[0]!.state !== "pending_approval") throw new Error("the refused stamp changed the state");
    // The knowledge pack is untouched by memory writes: the retrieval
    // filter (0024) reads content_type 'knowledge_entry' only — the
    // correction row is invisible to it.
    const retrievable = await db.query<{ n: number }>(
      `select count(*)::int as n from public.content_items
       where business_id = $1 and content_type = 'knowledge_entry' and state = 'published' and archived_at is null
         and id = $2`,
      [f.business_id, correction.rows[0]!.id]
    );
    if (retrievable.rows[0]!.n !== 0) throw new Error("a correction row is visible to retrieval");
    // The human hand passes — the stamp is the 0009 gate working.
    await db.query(
      `update public.content_items set state = 'published', published_by_actor_id = $2, published_at = now() where id = $1`,
      [correction.rows[0]!.id, f.human_id]
    );
  });

  await expectOk("the wiring stands (source-pinned): rejections write observations; a fact edit sweeps; promotion is one evented human act; the seed writes through the door", async () => {
    const inboxSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/inbox/actions.ts"),
      "utf8"
    );
    if (!inboxSource.includes("recordRejectionObservation(db, {")) {
      throw new Error("a rejection no longer lands in Memory as an observation");
    }
    const memoryActionsSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/memory/actions.ts"),
      "utf8"
    );
    for (const marker of ["sweepFactEdit(db, {", "promoteObservation(db, {", "supersedeMemoryEntry(db, {"]) {
      if (!memoryActionsSource.includes(marker)) throw new Error(`the memory surface lost its door: ${marker}`);
    }
    const memorySource = readFileSync(resolve(import.meta.dirname, "../src/memory.ts"), "utf8");
    for (const marker of [
      "MEMORY_EVENT_KINDS.factRippleSwept",
      "MEMORY_EVENT_KINDS.observationPromoted",
      "MEMORY_EVENT_KINDS.entrySuperseded",
      'state: "pending_approval"',
    ]) {
      if (!memorySource.includes(marker)) throw new Error(`the memory module lost its wiring: ${marker}`);
    }
    const seedSource = readFileSync(resolve(import.meta.dirname, "../src/memory-seed.ts"), "utf8");
    for (const marker of ["createMemoryEntry(", "FEE_PROHIBITION_LINE", "REGISTER_PUNCTUATION_LINE"]) {
      if (!seedSource.includes(marker)) throw new Error(`the seed no longer writes the ruled truth: ${marker}`);
    }
    // The settings faces write through the memory door (Q1 option A).
    const settingsSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/settings/actions.ts"),
      "utf8"
    );
    if (!settingsSource.includes("setMemoryFact(db, {")) {
      throw new Error("a Settings face stopped writing through the memory door");
    }
  });

  // ---------------------------------------------------------------------
  // Fact-surfaces micro-fix (6 Aug 2026, D144 hotfix class): every fact
  // creation door shares ONE per-key default-surfaces declaration; a
  // supersede can change the surfaces list and the sweep follows the
  // successor's; the Settings faces READ the memory home they write.
  // ---------------------------------------------------------------------
  console.log("\nFact-surfaces micro-fix:");

  await expectOk("a face-created hours fact carries the GMB surface — ONE shared per-key declaration for every door, never two lists", async () => {
    for (const key of ["opening_hours", "phone"]) {
      const defaults = defaultSurfacesForFactKey(key);
      if (defaults.length !== 1 || defaults[0] !== GOOGLE_BUSINESS_PROFILE_SURFACE) {
        throw new Error(`"${key}" does not default to the Google Business Profile surface`);
      }
      if (defaults[0]!.in_platform) throw new Error("GMB is not connected — it must be an external (manual-task) surface");
    }
    if (defaultSurfacesForFactKey("signature").length !== 0 || defaultSurfacesForFactKey("custom_fact").length !== 0) {
      throw new Error("a key with no worldly default gained surfaces");
    }
    // Every creation door consumes the shared declaration — and the seed's
    // former local list is gone (two lists were the defect).
    const memorySource = readFileSync(resolve(import.meta.dirname, "../src/memory.ts"), "utf8");
    if ((memorySource.match(/defaultSurfacesForFactKey\(input\.fact_key\)/g) ?? []).length < 2) {
      throw new Error("setMemoryFact no longer attaches (create) and heals (supersede-over-empty) the shared defaults");
    }
    const seedSource = readFileSync(resolve(import.meta.dirname, "../src/memory-seed.ts"), "utf8");
    if (!seedSource.includes("defaultSurfacesForFactKey(key)")) throw new Error("the seed grew back its own list");
    if (seedSource.includes("GMB_SURFACE")) throw new Error("the seed still carries a second, local GMB declaration");
    const memoryActionsSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/memory/actions.ts"),
      "utf8"
    );
    if (!memoryActionsSource.includes("defaultSurfacesForFactKey(factKey)")) {
      throw new Error("the Memory surface's add door does not attach the shared defaults");
    }
  });

  await expectOk("a supersede can CHANGE the surfaces list — the successor carries the new list and the sweep follows it", async () => {
    const declA = JSON.stringify([GOOGLE_BUSINESS_PROFILE_SURFACE]);
    const declB = JSON.stringify([
      GOOGLE_BUSINESS_PROFILE_SURFACE,
      { surface: "knowledge_entry", label: "Booking policy", ref: "ci-x", in_platform: true },
    ]);
    const p = await db.query<{ id: string }>(
      `insert into public.memory_entries (business_id, created_by, kind, title, body, surfaces, attributes)
       values ($1, $2, 'fact', 'Hours (surfaces test)', '09:00 to 17:00', $3::jsonb, '{"fact_key":"s32fix_hours"}'::jsonb) returning id`,
      [f.business_id, f.human_id, declA]
    );
    const s = await db.query<{ id: string; surfaces: unknown }>(
      `insert into public.memory_entries (business_id, created_by, kind, title, body, surfaces, attributes)
       values ($1, $2, 'fact', 'Hours (surfaces test)', '10:00 to 16:00', $3::jsonb, '{"fact_key":"s32fix_hours_next"}'::jsonb) returning id, surfaces`,
      [f.business_id, f.human_id, declB]
    );
    await db.query(
      `update public.memory_entries set active = false, superseded_by_entry_id = $2 where id = $1`,
      [p.rows[0]!.id, s.rows[0]!.id]
    );
    const successorSurfaces = s.rows[0]!.surfaces as Array<{ surface: string }>;
    if (successorSurfaces.length !== 2) throw new Error("the successor did not carry the changed list");
    // The sweep plans FROM the successor's list: the newly declared
    // in-platform carrier is corrected, the external surface tasks.
    const plan = planFactSweep({
      fact_title: "Hours (surfaces test)",
      old_value: "09:00 to 17:00",
      new_value: "10:00 to 16:00",
      carriers: [
        { decl: { surface: "google_business_profile", label: "Google Business Profile", ref: null, in_platform: false } },
        {
          decl: { surface: "knowledge_entry", label: "Booking policy", ref: "ci-x", in_platform: true },
          entry: { id: "ci-x", title: "Booking policy", version: 1, body: [{ type: "paragraph", text: "Open 09:00 to 17:00 daily." }] },
        },
      ],
    });
    if (plan.corrections.length !== 1 || plan.tasks.length !== 1) {
      throw new Error("the sweep did not follow the successor's list");
    }
    // The edit door hands the SUCCESSOR to the sweep — never the predecessor.
    const memoryActionsSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/memory/actions.ts"),
      "utf8"
    );
    if (!memoryActionsSource.includes("fact: successor")) {
      throw new Error("the Memory edit door no longer sweeps the successor's list");
    }
  });

  await expectOk("the Settings face renders the ACTIVE memory value after a Memory-side supersede — the faces read the home they write", async () => {
    // Query-level: the active-context read after a supersede holds only the
    // successor, and the memory-first resolvers render exactly it.
    const before: MemoryContext = {
      instructions: [],
      facts: [{ id: "sig-1", key: "signature", title: "Signature", body: "X Law" }],
    };
    const after: MemoryContext = {
      instructions: [],
      facts: [{ id: "sig-2", key: "signature", title: "Signature", body: "X Law Client Team" }],
    };
    const staleSettings = { email_sign_off: "X Law" };
    if (resolveSignOffWithMemory(before, staleSettings, "X Law") !== "X Law") throw new Error("pre-edit read wrong");
    if (resolveSignOffWithMemory(after, staleSettings, "X Law") !== "X Law Client Team") {
      throw new Error("a Memory-side supersede does not render through the face's resolver");
    }
    if (memoryFactValue(after, "signature") !== "X Law Client Team") throw new Error("memoryFactValue misread");
    // Component-level pins: every General-tab field reads memory-first —
    // sign-off, booking link AND the hours control's memoryValue — and the
    // memory doors revalidate the Settings path so the edit renders
    // immediately in both places.
    const generalTabSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/settings/general-tab.tsx"),
      "utf8"
    );
    for (const marker of [
      "memoryFactValue(memory, MEMORY_FACT_KEYS.signature)",
      "memoryFactValue(memory, MEMORY_FACT_KEYS.bookingLink)",
      "memoryFactValue(memory, MEMORY_FACT_KEYS.openingHours)",
    ]) {
      if (!generalTabSource.includes(marker)) throw new Error(`the Settings face stopped reading memory-first: ${marker}`);
    }
    const hoursControlSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/settings/business-hours-control.tsx"),
      "utf8"
    );
    if (!hoursControlSource.includes("value.memoryValue")) {
      throw new Error("the hours control does not render the memory fact");
    }
    const memoryActionsSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/memory/actions.ts"),
      "utf8"
    );
    if (!memoryActionsSource.includes('revalidatePath("/settings")')) {
      throw new Error("memory writes do not revalidate the Settings path — the one-way mirror stands");
    }
  });

  // ---------------------------------------------------------------------
  // Session 33 — quiet hours: the choice at the stamp (D184). The silent
  // hold-until-window is retired on the stamp surfaces in favour of the
  // explicit choice; quiet hours can be turned OFF entirely (explicit
  // null); a chosen timing rides the row and survives dispatch — but not
  // a retry (D163: policy re-applies fresh).
  // ---------------------------------------------------------------------
  console.log("\nSession 33 — quiet hours: the choice at the stamp (D184):");
  // An earlier smoke leaves the jwt-sub GUC pointing at the harness user;
  // these smokes act through the pipeline doors as the activation owner.
  await db.exec(`set request.jwt.claim.sub = ''`);

  await expectOk("quiet hours OFF (D184b, the explicit null): no hold at ANY hour — a midnight stamp dispatches immediately", async () => {
    const off = resolveQuietHours({ quiet_hours: null }, { start: "20:00", end: "08:00" });
    if (off !== null) throw new Error("the explicit null did not turn quiet hours off");
    for (const at of ["2026-08-07T00:30:00Z", "2026-08-07T03:00:00Z", "2026-08-07T22:15:00Z"]) {
      if (quietHoursHoldUntil(new Date(at), "Europe/London", off)) {
        throw new Error(`${at} was held with quiet hours off`);
      }
    }
    // The Settings door writes the EXPLICIT null (a delete would resurrect
    // the default window) as an owner-set first-class choice, evented.
    const settingsSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/settings/actions.ts"),
      "utf8"
    );
    if (!settingsSource.includes("settings.quiet_hours = null")) {
      throw new Error("Settings lost the explicit-null off switch (D184b)");
    }
    if (!settingsSource.includes('mode === "disable"')) {
      throw new Error("the No-quiet-hours mode left the settings door");
    }
    const controlSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/settings/business-hours-control.tsx"),
      "utf8"
    );
    if (!controlSource.includes("no quiet hours")) {
      throw new Error("the first-class No-quiet-hours choice left the Settings surface");
    }
    if (!controlSource.includes("Quiet hours off — stamped mail dispatches immediately, any hour")) {
      throw new Error("the off state no longer renders honestly (D184b's own words)");
    }
  });

  await expectOk("No quiet hours is a DISPATCH choice only (D184b as amended at click-review): the opening-hours fact stands, still sweeps GMB, and the row states both truths", async () => {
    // The Settings door: the disable arm touches NO memory — only the reset
    // arm retires the fact (the shipped default window is dispatch policy).
    const settingsSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/settings/actions.ts"),
      "utf8"
    );
    const disableAt = settingsSource.indexOf('if (mode === "disable") {');
    const resetAt = settingsSource.indexOf('} else if (mode === "reset") {');
    if (disableAt === -1 || resetAt === -1 || resetAt < disableAt) {
      throw new Error("the disable/reset arms reshaped — re-pin the fact-retirement boundary");
    }
    const disableArm = settingsSource.slice(disableAt, resetAt);
    if (disableArm.includes("deactivateMemoryEntry")) {
      throw new Error("the disable arm retires the opening-hours fact — the amended ruling forbids it");
    }
    if (!settingsSource.slice(resetAt).includes("deactivateMemoryEntry")) {
      throw new Error("the reset arm no longer retires the fact — the reset lane changed");
    }
    // Decoupled truths, pure: the hold is OFF while the fact lives on and a
    // subsequent fact edit still raises the GMB manual task.
    if (resolveQuietHours({ quiet_hours: null }, { start: "20:00", end: "08:00" }) !== null) {
      throw new Error("the explicit null stopped turning the hold off");
    }
    const plan = planFactSweep({
      fact_title: "Opening hours",
      old_value: "09:00 to 17:00 (Europe/London)",
      new_value: "10:00 to 16:00 (Europe/London)",
      carriers: [{ decl: { surface: "google_business_profile", label: "Google Business Profile", ref: null, in_platform: false } }],
    });
    if (plan.tasks.length !== 1 || !/Google Business Profile/.test(plan.tasks[0]!.title)) {
      throw new Error("an opening-hours edit no longer sweeps GMB — the fact's worldly ripple broke");
    }
    // The row states both truths.
    const controlSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/settings/business-hours-control.tsx"),
      "utf8"
    );
    if (!controlSource.includes("Opening hours unchanged:")) {
      throw new Error("the off state no longer states the second truth (the standing fact)");
    }
  });

  await expectOk("approve INSIDE the window without a choice is impossible — the gate withholds the stamp before ANY work; the dialogue is the only path", async () => {
    const inboxSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/inbox/actions.ts"),
      "utf8"
    );
    const gateAt = inboxSource.indexOf("quietChoiceRequired: { until:");
    const signOffAt = inboxSource.indexOf("resolveSignOffAtStamp(db, business, actor, communicationId)");
    const stampAt = inboxSource.indexOf("await approveCommunication(db, {");
    if (gateAt === -1) throw new Error("the D184c gate left approveAction");
    if (signOffAt === -1 || stampAt === -1) throw new Error("approveAction reshaped — re-pin the gate ordering");
    if (!(gateAt < signOffAt && gateAt < stampAt)) {
      throw new Error("the gate no longer precedes the stamp (and the sign-off compliance write)");
    }
    if (!inboxSource.includes("windowEnds && !quietChoice")) {
      throw new Error("the gate's condition changed — an unchosen in-window approve must return the dialogue's facts");
    }
    // The gate reads the SAME resolver as the dispatch hold (the 170 law:
    // display, dialogue and enforcement cannot disagree).
    if (!inboxSource.includes("getInstalledQuietHoursDefault(db, business.id)")) {
      throw new Error("the gate no longer resolves through the installed template's declaration");
    }
  });

  await expectOk("SEND NOW at the stamp is the s24 override — the 0039 door plus the evented communication.quiet_hours_overridden; the schedule act is evented too", async () => {
    const inboxSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/inbox/actions.ts"),
      "utf8"
    );
    const branchAt = inboxSource.indexOf('quietChoice === "send_now" && heldUntil');
    if (branchAt === -1) throw new Error("the send-now choice left approveAction");
    const branch = inboxSource.slice(branchAt);
    if (!branch.includes("override_quiet_hours_hold")) throw new Error("Send now no longer rides the 0039 door");
    if (!branch.includes("SEND_EVENT_KINDS.communicationQuietHoursOverridden")) {
      throw new Error("Send now no longer events the override");
    }
    if (!inboxSource.includes("SEND_EVENT_KINDS.communicationScheduled")) {
      throw new Error("the schedule choice is no longer evented");
    }
    const kinds = readFileSync(resolve(import.meta.dirname, "../src/event-kinds.ts"), "utf8");
    if (!kinds.includes(`"communication.scheduled"`)) {
      throw new Error("the scheduled ledger kind left the declared vocabulary");
    }
  });

  await expectOk("APPROVE AND SCHEDULE: the stamp lands with scheduled_for set; dispatch honours the chosen time and never re-holds a chosen timing", async () => {
    const id = await trioHeldComm();
    // The action's write, mirrored against a real stamped row: the chosen
    // instant plus the 0039-shaped marker (who chose, when).
    await db.query(
      `update public.communications
       set scheduled_for = now() + interval '3 hours',
           attributes = coalesce(attributes, '{}'::jsonb)
             || jsonb_build_object('quiet_hours_override',
                  jsonb_build_object('by_actor_id', $2::text, 'at', now(), 'scheduled_for', (now() + interval '3 hours')))
       where id = $1`,
      [id, activation!.owner_actor_id]
    );
    const row = await db.query<{ status: string; future: boolean; attributes: Record<string, unknown> }>(
      `select status, (scheduled_for > now()) as future, attributes from public.communications where id = $1`,
      [id]
    );
    if (row.rows[0]!.status !== "approved") throw new Error("the schedule touched STATUS — timing only is the law");
    if (!row.rows[0]!.future) throw new Error("scheduled_for did not land in the future");
    // The dispatcher's machinery: due-ness by scheduled_for (the D163
    // predicate + the per-row skip), and the marker rule keeps a chosen
    // time from being re-held even when it falls inside the window.
    const sendSource = readFileSync(resolve(import.meta.dirname, "../src/send.ts"), "utf8");
    if (!sendSource.includes("scheduled_for.is.null,scheduled_for.lte.")) {
      throw new Error("the dispatcher's due predicate changed — scheduled rows would be missed");
    }
    if (!sendSource.includes("new Date(comm.scheduled_for) > now")) {
      throw new Error("the dispatcher's per-row future skip changed");
    }
    if (!sendSource.includes("honourQuietHoursOverride(comm.attributes)")) {
      throw new Error("the dispatcher no longer consults the marker rule before holding");
    }
    if (!honourQuietHoursOverride(row.rows[0]!.attributes)) {
      throw new Error("a standing chosen timing was not honoured — the dispatcher would re-hold it");
    }
    // The marker rule's edges, pure: no marker holds as policy; a marker
    // that cannot prove it postdates a retry is spent (fail towards the hold).
    if (honourQuietHoursOverride({})) throw new Error("no marker was honoured");
    if (honourQuietHoursOverride(null)) throw new Error("null attributes were honoured");
    if (
      honourQuietHoursOverride({
        quiet_hours_override: { by_actor_id: "x" },
        send_retry: { by_actor_id: "x", at: "2026-08-07T01:00:00Z" },
      })
    ) {
      throw new Error("an at-less marker beat a retry — it must fail towards the hold");
    }
  });

  await expectOk("the retry ruling (163) stands: RETRY nulls scheduled_for AND spends the pre-retry timing choice — policy re-applies fresh", async () => {
    const id = await pairFailedComm();
    await db.query(
      `update public.communications
       set scheduled_for = now() + interval '5 hours',
           attributes = coalesce(attributes, '{}'::jsonb)
             || jsonb_build_object('quiet_hours_override',
                  jsonb_build_object('by_actor_id', $2::text, 'at', (now() - interval '1 hour')))
       where id = $1`,
      [id, activation!.owner_actor_id]
    );
    await db.query(`select public.retry_failed_communication($1, $2)`, [id, activation!.owner_actor_id]);
    const after = await db.query<{ sf: string | null; attributes: Record<string, unknown> }>(
      `select scheduled_for as sf, attributes from public.communications where id = $1`,
      [id]
    );
    if (after.rows[0]!.sf !== null) throw new Error("the retry did not null scheduled_for (D163)");
    if (honourQuietHoursOverride(after.rows[0]!.attributes)) {
      throw new Error("a pre-retry timing choice survived the retry — D163 says policy re-applies fresh");
    }
    // A FRESH choice made after the retry stands — the retry spends only
    // what predates it.
    if (
      !honourQuietHoursOverride({
        ...after.rows[0]!.attributes,
        quiet_hours_override: { by_actor_id: "x", at: new Date(Date.now() + 60_000).toISOString() },
      })
    ) {
      throw new Error("a post-retry choice was not honoured");
    }
  });

  await expectOk("both approve surfaces share the ONE dialogue (D184d) — and the card states the truth after the choice; bulk approve still does not exist", async () => {
    const controlsSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/inbox/decision-controls.tsx"),
      "utf8"
    );
    if (!controlsSource.includes("Quiet hours until")) throw new Error("the choice dialogue left DecisionControls");
    for (const marker of ['value="send_now"', 'value="schedule"']) {
      if (!controlsSource.includes(marker)) throw new Error(`the dialogue lost an act: ${marker}`);
    }
    if (
      !controlsSource.includes("stamped · scheduled for") ||
      !controlsSource.includes("stamped · sent now (quiet-hours override)")
    ) {
      throw new Error("the card no longer states the truth after the choice (D184, B4)");
    }
    const threadSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/conversations/draft-stamp-panel.tsx"),
      "utf8"
    );
    if (!threadSource.includes("<DecisionControls")) {
      throw new Error("the thread's inline approve no longer shares the component");
    }
    const cardSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/inbox/inbox-card.tsx"),
      "utf8"
    );
    if (!cardSource.includes("<DecisionControls")) {
      throw new Error("the inbox card no longer shares the component");
    }
    const actionsSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/inbox/actions.ts"),
      "utf8"
    );
    if (/bulkApprove/i.test(actionsSource)) throw new Error("a bulk approve appeared — D113 forbids it, forever");
  });

  // ---------------------------------------------------------------------
  // Quiet-window micro-fix (7 Aug 2026, D144 hotfix class): the Quiet
  // hours row states the resolved window with its TRUE source and gains
  // its own editor through the one shared door; the supersede fact-heal
  // clause extends to the Memory edit door.
  // ---------------------------------------------------------------------
  console.log("\nQuiet-window micro-fix:");

  await expectOk("the Quiet hours row names the TRUE source for every state — firm-set WINS the resolver, template default and off are named, the claimed derivation is gone", async () => {
    const declared = { start: "20:00", end: "08:00" };
    // A firm-set window wins (D170), and says so.
    const firm = resolveQuietHoursWithSource({ quiet_hours: { start: "21:00", end: "07:30" } }, declared);
    if (firm.source !== "firm" || firm.window?.start !== "21:00" || firm.window?.end !== "07:30") {
      throw new Error("a firm-set window no longer wins the resolver as source 'firm'");
    }
    // Unset firm → the installed template's declared default, named.
    const template = resolveQuietHoursWithSource({}, declared);
    if (template.source !== "template" || template.window?.start !== "20:00") {
      throw new Error("the template default no longer resolves as source 'template'");
    }
    // Install-less → the shipped constant, named as its own honest state
    // (labelling it "template default" would repeat the witnessed defect).
    const shipped = resolveQuietHoursWithSource({}, null);
    if (shipped.source !== "shipped" || shipped.window !== QUIET_HOURS_DEFAULT) {
      throw new Error("the install-less constant no longer resolves as source 'shipped'");
    }
    // Explicit null → off.
    const off = resolveQuietHoursWithSource({ quiet_hours: null }, declared);
    if (off.source !== "off" || off.window !== null) throw new Error("the explicit null no longer resolves as source 'off'");
    // ONE resolution: the plain resolver is the with-source resolver minus
    // provenance — display and enforcement cannot disagree.
    for (const s of [{}, { quiet_hours: null }, { quiet_hours: { start: "21:00", end: "07:30" } }]) {
      const a = resolveQuietHours(s, declared);
      const b = resolveQuietHoursWithSource(s, declared).window;
      if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error("the two resolvers diverged — one truth split");
    }
    // The row: honest provenance rendered, the false derivation gone.
    const generalTabSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/settings/general-tab.tsx"),
      "utf8"
    );
    if (generalTabSource.includes("outside the business hours above")) {
      throw new Error("the row still claims a derivation from business hours that does not exist");
    }
    if (!generalTabSource.includes("resolveQuietHoursWithSource(")) {
      throw new Error("the row no longer resolves with provenance");
    }
    const quietControlSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/settings/quiet-hours-control.tsx"),
      "utf8"
    );
    for (const label of ['"firm-set"', '"template default"', '"shipped default"', "Off — dispatch any hour"]) {
      if (!quietControlSource.includes(label)) throw new Error(`the row lost a true-source state: ${label}`);
    }
  });

  await expectOk("the quiet window's editor shares the ONE door — set_quiet is dispatch policy only (no fact write), and no-quiet-hours is the s33 disable arm, never a second implementation", async () => {
    const settingsSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/settings/actions.ts"),
      "utf8"
    );
    const setQuietAt = settingsSource.indexOf('} else if (mode === "set_quiet") {');
    const finalElseAt = setQuietAt === -1 ? -1 : settingsSource.indexOf("} else {", setQuietAt);
    if (setQuietAt === -1 || finalElseAt === -1) {
      throw new Error("the set_quiet arm reshaped — re-pin the dispatch-only boundary");
    }
    const setQuietArm = settingsSource.slice(setQuietAt, finalElseAt);
    if (setQuietArm.includes("setMemoryFact") || setQuietArm.includes("deactivateMemoryEntry")) {
      throw new Error("the set_quiet arm touches the opening-hours fact — the s33 amendment severed dispatch policy from opening hours");
    }
    if (!settingsSource.includes("dispatch policy only; the opening-hours fact untouched")) {
      throw new Error("the set_quiet save is no longer evented naming the change");
    }
    const quietControlSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/settings/quiet-hours-control.tsx"),
      "utf8"
    );
    if (!quietControlSource.includes("setBusinessHoursAction")) {
      throw new Error("the quiet editor grew its own door — one shared action is the law here");
    }
    if (!quietControlSource.includes('value="set_quiet"') || !quietControlSource.includes('value="disable"')) {
      throw new Error("the quiet editor lost an act (set_quiet / the shared disable arm)");
    }
  });

  await expectOk("the Memory-door supersede heals an empty, untouched surfaces list to the per-key defaults — the next sweep raises the GMB task; a deliberate list is never overridden", async () => {
    const emptyHoursFact = {
      kind: "fact" as const,
      surfaces: [],
      attributes: { fact_key: "opening_hours" },
    };
    // Untouched empty list → healed to the shared per-key defaults.
    const healed = healedCarriedSurfaces(emptyHoursFact);
    if (healed.length !== 1 || healed[0] !== GOOGLE_BUSINESS_PROFILE_SURFACE) {
      throw new Error("an untouched empty list did not heal to the per-key defaults");
    }
    // …and the next sweep raises the GMB manual task from the healed list.
    const plan = planFactSweep({
      fact_title: "Opening hours",
      old_value: "09:00 to 17:00 (Europe/London)",
      new_value: "09:30 to 17:30 (Europe/London)",
      carriers: healed.map((decl) => ({ decl })),
    });
    if (plan.tasks.length !== 1 || !/Google Business Profile/.test(plan.tasks[0]!.title)) {
      throw new Error("the healed list did not sweep to the GMB task");
    }
    // The guards: a deliberately passed list — even empty — is never
    // overridden; a non-empty predecessor list carries forward; a keyless
    // fact and a non-fact heal nothing.
    if (healedCarriedSurfaces(emptyHoursFact, []).length !== 0) {
      throw new Error("a deliberately emptied list was overridden — the guard fell");
    }
    const declared = [{ surface: "knowledge_entry", label: "Booking policy", ref: "ci-x", in_platform: true }];
    if (healedCarriedSurfaces(emptyHoursFact, declared) !== declared) {
      throw new Error("a deliberately edited list was overridden — the guard fell");
    }
    const carried = healedCarriedSurfaces({ kind: "fact", surfaces: declared, attributes: { fact_key: "opening_hours" } });
    if (carried !== declared) throw new Error("a non-empty predecessor list no longer carries forward");
    if (healedCarriedSurfaces({ kind: "fact", surfaces: [], attributes: {} }).length !== 0) {
      throw new Error("a keyless fact grew surfaces from nowhere");
    }
    if (healedCarriedSurfaces({ kind: "instruction", surfaces: [], attributes: {} }).length !== 0) {
      throw new Error("a non-fact entry grew surfaces");
    }
    // The supersede door consumes the clause — the Memory edit form's
    // value-only edit (surfaces untouched) heals through it.
    const memorySource = readFileSync(resolve(import.meta.dirname, "../src/memory.ts"), "utf8");
    if (!memorySource.includes("healedCarriedSurfaces(predecessor, input.surfaces)")) {
      throw new Error("supersedeMemoryEntry no longer consumes the heal clause");
    }
  });

  // ---------------------------------------------------------------------
  // Lead-context micro-fix (7 Aug 2026, D144 hotfix class, D186): ingest
  // creates the whatsapp channel beside phone and email with the form's
  // consent; the returning path enriches it like a sibling; the panel
  // renders two honest registers with fold-into-channel.
  // ---------------------------------------------------------------------
  console.log("\nLead-context micro-fix (D186):");

  await expectOk("a Meta lead-form ingest yields THREE consented channels — and the consent pre-flight passes a whatsapp send for a fresh lead (refused without the D186 row, passing with it)", async () => {
    // The fresh path writes whatsapp beside phone and email, one consent
    // shape (source pin — the write path is TS over Supabase).
    const metaSource = readFileSync(resolve(import.meta.dirname, "../src/meta.ts"), "utf8");
    if (!metaSource.includes(`{ channel: "whatsapp", value: phone }`)) {
      throw new Error("the fresh ingest path no longer creates the whatsapp channel (D186)");
    }
    // The DEFECT shape first: a pre-D186 fresh lead (phone + email only) —
    // the consent pre-flight refuses a whatsapp send.
    const lead = await db.query<{ id: string }>(
      `insert into public.contacts (business_id, created_by, type, display_name, given_name)
       values ($1, $2, 'person', 'Noor Fatima', 'Noor') returning id`,
      [f.business_id, f.agent_id]
    );
    const leadId = lead.rows[0]!.id;
    const consent = '{"marketing": true, "transactional": true, "granted_at": "2026-08-07T09:00:00Z", "source": "meta_lead_form"}';
    await db.query(
      `insert into public.contact_channels (business_id, created_by, contact_id, channel, value, is_primary, consent)
       values ($1, $2, $3, 'phone', '+447700900777', true, $4::jsonb),
              ($1, $2, $3, 'email', 'noor@example.test', true, $4::jsonb)`,
      [f.business_id, f.agent_id, leadId, consent]
    );
    const waThread = await db.query<{ id: string }>(
      `insert into public.comm_threads (business_id, created_by, contact_id, channel)
       values ($1, $2, $3, 'whatsapp') returning id`,
      [f.business_id, f.agent_id, leadId]
    );
    const draft = await db.query<{ id: string }>(
      `insert into public.communications (business_id, created_by, thread_id, contact_id, channel, direction, status, body, drafted_by_actor_id)
       values ($1, $2, $3, $4, 'whatsapp', 'outbound', 'draft', 'Salaam Noor, thank you for your enquiry.', $2) returning id`,
      [f.business_id, f.agent_id, waThread.rows[0]!.id, leadId]
    );
    const consentCheck = async () => {
      const r = await db.query<{ result: { checks: Array<{ key: string; pass: boolean }> } }>(
        `select public.preflight_communication($1) as result`,
        [draft.rows[0]!.id]
      );
      return r.rows[0]!.result.checks.find((c) => c.key === "consent");
    };
    const before = await consentCheck();
    if (!before || before.pass !== false) {
      throw new Error("the pre-D186 shape did not refuse on whatsapp consent — the defect this ruling fixes is mis-modelled");
    }
    // The D186 row lands (ingest's exact shape) — the same pre-flight passes.
    await db.query(
      `insert into public.contact_channels (business_id, created_by, contact_id, channel, value, is_primary, consent)
       values ($1, $2, $3, 'whatsapp', '+447700900777', true, $4::jsonb)`,
      [f.business_id, f.agent_id, leadId, consent]
    );
    const after = await consentCheck();
    if (!after || after.pass !== true) {
      throw new Error("the consent pre-flight does not pass a whatsapp send for a D186 fresh lead");
    }
    const rows = await db.query<{ n: number }>(
      `select count(*)::int as n from public.contact_channels
       where contact_id = $1 and archived_at is null
         and coalesce((consent ->> 'transactional')::boolean, false)
         and coalesce((consent ->> 'marketing')::boolean, false)
         and consent ->> 'source' = 'meta_lead_form'`,
      [leadId]
    );
    if (rows.rows[0]!.n !== 3) throw new Error("the ingest shape does not hold three consented channels");
  });

  await expectOk("whatsapp ingest is idempotent and resolution never consults it — an existing row stands the plan down; a whatsapp-only match resolves to no one (D174a untouched)", async () => {
    const withWa = [
      { contact_id: "c1", channel: "phone", value: "+447222" },
      { contact_id: "c1", channel: "whatsapp", value: "+447222" },
    ];
    if (planChannelEnrichment(withWa, null, "+447222").some((p) => p.channel === "whatsapp")) {
      throw new Error("an existing whatsapp row did not stand the plan down");
    }
    const waOnly = [{ contact_id: "c1", channel: "whatsapp", value: "+447222" }];
    if (resolveKnownContactId(waOnly, null, "+447222") !== null) {
      throw new Error("resolution consulted a whatsapp row — D174a keys on email and phone only");
    }
    // The lookup reads whatsapp rows solely to feed the plan's stand-down.
    const returningSource = readFileSync(resolve(import.meta.dirname, "../src/returning-leads.ts"), "utf8");
    if (!returningSource.includes(`.in("channel", ["email", "phone", "whatsapp"])`)) {
      throw new Error("the known-contact lookup no longer reads whatsapp rows for idempotency");
    }
  });

  await expectOk("the lead-context panel folds identical values into the channel line and keeps divergent answers verbatim — two honest registers", async () => {
    const channels = [
      { channel: "phone", value: "+447700900777", consented: true },
      { channel: "whatsapp", value: "+447700900777", consented: true },
      { channel: "email", value: "noor@example.test", consented: true },
    ];
    const folded = foldLeadContext(
      [
        { label: "Full name", value: "Noor Fatima" },
        { label: "Email", value: "Noor@Example.TEST" },
        { label: "Phone number", value: "+447700900777" },
        { label: "Phone (formatted)", value: "07700 900777" },
      ],
      channels
    );
    // The email answer folds case-insensitively; the phone answer folds
    // byte-identically into BOTH the phone and whatsapp lines.
    const labels = folded.answers.map((a) => a.label);
    if (labels.includes("Email")) throw new Error("a case-insensitively equal email answer did not fold");
    if (labels.includes("Phone number")) throw new Error("a byte-identical phone answer did not fold");
    if (!labels.includes("Full name")) throw new Error("a non-channel answer vanished");
    if (!labels.includes("Phone (formatted)")) {
      throw new Error("a differently formatted answer folded — divergent answers must stay verbatim");
    }
    const phoneLine = folded.channels.find((c) => c.channel === "phone");
    const waLine = folded.channels.find((c) => c.channel === "whatsapp");
    const emailLine = folded.channels.find((c) => c.channel === "email");
    if (!phoneLine?.foldedAnswerLabels.includes("Phone number") || !waLine?.foldedAnswerLabels.includes("Phone number")) {
      throw new Error("the folded phone answer is not carried on the channel lines");
    }
    if (!emailLine?.foldedAnswerLabels.includes("Email")) {
      throw new Error("the folded email answer is not carried on the email line");
    }
    // The panel renders the two registers and consumes the fold (tripwire).
    const cardSource = readFileSync(
      resolve(import.meta.dirname, "../../../apps/web/app/(app)/inbox/inbox-card.tsx"),
      "utf8"
    );
    if (!cardSource.includes("Form answers — verbatim as the lead gave them")) {
      throw new Error("the FORM ANSWERS register lost its honest heading");
    }
    if (!cardSource.includes("Channels &amp; consent")) {
      throw new Error("the CHANNELS & CONSENT register lost its heading");
    }
    if (!cardSource.includes("foldLeadContext(context.answers, context.channels)")) {
      throw new Error("the panel no longer folds through the shared helper");
    }
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}

/** Minutes past local midnight in Europe/London for an instant — the trio
 * smoke's window assertion helper. */
function minutesOfDayInLondon(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

main().catch((err) => {
  console.error("check-local crashed:", err);
  process.exit(1);
});
