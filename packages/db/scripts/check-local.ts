import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

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
  await expectOk("outbound comm sends with a human approver", () =>
    db.query(
      `insert into public.communications (business_id, created_by, thread_id, channel, direction, status, body, approved_by_actor_id)
       values ($1, $2, $3, 'email', 'outbound', 'sent', 'hello', $4)`,
      [f.business_id, f.agent_id, thread.rows[0]!.id, f.human_id]
    )
  );

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

  await expectOk("a granted agent drafts an outbound email (the Light path)", () =>
    db.query(
      `insert into public.communications (business_id, created_by, thread_id, channel, direction, status, body, drafted_by_actor_id)
       values ($1, $2, $3, 'email', 'outbound', 'draft', 'Draft for approval', $2)`,
      [f.business_id, f.agent_id, thread.rows[0]!.id]
    )
  );

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
    await db.query(
      `insert into public.communications (business_id, created_by, thread_id, channel, direction, status, body, approved_by_actor_id)
       values ($1, $2, $3, 'email', 'outbound', 'approved', 'hello again', $4)`,
      [f.business_id, f.agent_id, thread.rows[0]!.id, h2.human2_id]
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

  // RLS: tenancy walls
  console.log("\nRow-Level Security:");
  await db.exec(`set role authenticated`);
  await db.exec(`set request.jwt.claim.sub = '${ids.user}'`);
  await expectOk("member sees their business's contacts", async () => {
    const r = await db.query<{ n: number }>(`select count(*)::int as n from public.contacts`);
    if (r.rows[0]!.n !== 1) throw new Error(`expected 1 contact, saw ${r.rows[0]!.n}`);
  });
  await expectError("member cannot hard-delete (no DELETE policy)", /no result|violates|denied|permission/i, async () => {
    const r = await db.query<{ n: number }>(
      `with d as (delete from public.contacts returning 1) select count(*)::int as n from d`
    );
    if (r.rows[0]!.n === 0) throw new Error("permission: delete removed no rows (policy denied)");
  });

  await db.exec(`set request.jwt.claim.sub = '${ids.stranger}'`);
  await expectOk("a stranger sees nothing", async () => {
    for (const table of ["contacts", "engagements", "events", "businesses", "tasks", "grants"]) {
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

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("check-local crashed:", err);
  process.exit(1);
});
