import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { scaleDurationMs } from "@rooshni/config";
import { verifyStripeSignature } from "../src/stripe";
import { verifyMetaSignature } from "../src/meta";
import { quietHoursHoldUntil, QUIET_HOURS_DEFAULT } from "../src/quiet-hours";
import { evaluateAutoClose } from "../src/auto-close";
import { dueNurtureStep, type NurtureStamps } from "../src/onboarding";
import { evaluateBasicsReadiness, resolveBasicsRequiredKeys, CANONICAL_BASICS_KEYS } from "../src/first-light";
import { resolveTemplateBody } from "../src/workflow";
import { formAnswersFromFieldData } from "../src/meta";
import {
  composeDraft,
  leadTextFromAnswers,
  matchRoutes,
  selectKnowledgeEntries,
  PermanentGenerationError,
  type GenerateFn,
  type KnowledgeEntry,
} from "../src/drafting";
import { resolveEscalation, LIGHT_MODEL_FLOOR, LIGHT_MODEL_ESCALATION, DRAFT_CONTEXT_BUDGETS } from "../src/model-router";

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

  const draftWa = async (body: string, attributes: string) => {
    const r = await db.query<{ id: string }>(
      `insert into public.communications (business_id, created_by, thread_id, contact_id, channel, direction, status, body, drafted_by_actor_id, attributes)
       values ($1, $2, $3, $4, 'whatsapp', 'outbound', 'draft', $5, $2, $6::jsonb) returning id`,
      [f.business_id, f.agent_id, waThread.rows[0]!.id, waContact.rows[0]!.id, body, attributes]
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

  await expectOk("task-scoped selection: route-matched service description + fees + booking, capped — never the whole pack", async () => {
    const pack: KnowledgeEntry[] = [
      { id: "sw", title: "Skilled Worker", category: "service_description", visa_route: "skilled_worker", text: "SW route." },
      { id: "sp", title: "Spouse", category: "service_description", visa_route: "spouse_family", text: "Spouse route." },
      { id: "fees", title: "Fees", category: "published_fees", visa_route: null, text: "Consultation £150." },
      { id: "book", title: "Booking", category: "consultation_booking_policy", visa_route: null, text: "Book online." },
      { id: "tone1", title: "Tone", category: "tone_exemplar", visa_route: null, text: "Warm, plain." },
      { id: "faq1", title: "Financial requirement", category: "faq", visa_route: null, text: "About the financial requirement." },
      { id: "faq2", title: "Sponsorship evidence", category: "faq", visa_route: null, text: "About sponsorship and employer evidence." },
    ];
    const result = selectKnowledgeEntries(pack, "My employer offered sponsorship for a skilled worker role");
    const ids = result.entries.map((e) => e.id);
    if (!ids.includes("sw")) throw new Error("route-matched service description missing");
    if (ids.includes("sp")) throw new Error("the OTHER route's service description was dumped in");
    if (!ids.includes("fees") || !ids.includes("book")) throw new Error("fees/booking policy missing");
    if (!ids.includes("faq2")) throw new Error("word-relevant FAQ missing");
    if (result.entries.length > DRAFT_CONTEXT_BUDGETS.max_pack_entries) throw new Error("selection exceeded the pack cap");
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
  const s15Draft = async (body: string) => {
    const r = await db.query<{ id: string }>(
      `insert into public.communications (business_id, created_by, thread_id, contact_id, channel, direction, status, body, drafted_by_actor_id)
       values ($1, $2, $3, $4, 'email', 'outbound', 'draft', $5, $2) returning id`,
      [activation!.business_id, activation!.light_actor_id, s15Thread.rows[0]!.id, s15Contact.rows[0]!.id, body]
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

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("check-local crashed:", err);
  process.exit(1);
});
