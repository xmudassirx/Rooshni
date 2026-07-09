import postgres from "postgres";
import { loadEnv } from "./env";

/**
 * Post-seed verification: prints row counts for the seeded tables and the
 * tail of the events ledger — the Spec 1 §7 steps 1–2 evidence.
 */
async function main() {
  loadEnv();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }

  const sql = postgres(databaseUrl, { ssl: "require", max: 1, prepare: false });

  try {
    const tables = [
      "accounts",
      "businesses",
      "actors",
      "memberships",
      "templates",
      "engagement_types",
      "stage_definitions",
      "field_definitions",
      "vocabulary",
      "contacts",
      "contact_channels",
      "engagements",
      "stage_history",
      "tasks",
      "comm_threads",
      "communications",
      "events",
      "permission_levels",
      "tools",
      "grants",
      "workflow_definitions",
      "workflow_steps",
      "workflow_runs",
      "step_runs",
      "message_templates",
    ];

    console.log("Row counts:");
    for (const table of tables) {
      const [row] = await sql`select count(*)::int as n from ${sql("public." + table)}`;
      console.log(`  ${table.padEnd(20)} ${row?.n ?? 0}`);
    }

    console.log("\nGrants (Spec 3 — who may do what):");
    const grants = await sql`
      select ge.display_name as grantee, g.tool, g.access, g.duration,
             g.scope ->> 'level' as scope_level, g.use_count,
             gb.display_name as granted_by, g.revoked_at
      from public.grants g
      join public.actors ge on ge.id = g.grantee_actor_id
      join public.actors gb on gb.id = g.granted_by_actor_id
      order by ge.display_name, g.tool
    `;
    for (const g of grants) {
      console.log(
        `  ${String(g.grantee).padEnd(16)} ${String(g.tool).padEnd(18)} ${String(g.access).padEnd(8)} ${String(g.scope_level).padEnd(10)} ${String(g.duration).padEnd(10)} uses ${String(g.use_count).padEnd(4)} by ${g.granted_by}${g.revoked_at ? "  [REVOKED]" : ""}`
      );
    }

    console.log("\nApproval inbox (Spec 3 §6 — stamps owed; the inbox is a view):");
    const inbox = await sql`
      select item_type, coalesce(channel, '') as channel, title, drafted_by,
             drafted_by_type, preflight_pass, awaiting_since
      from public.approval_inbox
      order by awaiting_since
    `;
    if (inbox.length === 0) {
      console.log("  (empty — no stamps owed)");
    }
    for (const i of inbox) {
      const preflight =
        i.preflight_pass === null ? "" : i.preflight_pass ? "pre-flight ✓" : "pre-flight BLOCKED";
      console.log(
        `  ${String(i.item_type).padEnd(14)} ${String(i.channel).padEnd(9)} ${String(i.title ?? "").slice(0, 44).padEnd(46)} by ${String(i.drafted_by ?? "?").padEnd(14)} (${i.drafted_by_type}) ${preflight}`
      );
    }

    console.log("\nCommunication pipeline states:");
    const comms = await sql`
      select c.status, c.channel, left(c.body, 40) as body,
             d.display_name as drafted_by, ap.display_name as approved_by,
             c.rejection_reason
      from public.communications c
      left join public.actors d on d.id = c.drafted_by_actor_id
      left join public.actors ap on ap.id = c.approved_by_actor_id
      order by c.id
    `;
    for (const c of comms) {
      const tail = c.approved_by
        ? `approved by ${c.approved_by}`
        : c.rejection_reason
          ? `rejected: "${c.rejection_reason}"`
          : "";
      console.log(
        `  ${String(c.status).padEnd(18)} ${String(c.channel).padEnd(9)} "${c.body}…" drafted by ${String(c.drafted_by ?? "?").padEnd(10)} ${tail}`
      );
    }

    console.log("\nWorkflow runs (Spec 4 — where is each enquiry and why):");
    const runs = await sql`
      select r.id, d.key as definition, e.title as engagement, r.status,
             s.key as current_step, r.started_at
      from public.workflow_runs r
      join public.workflow_definitions d on d.id = r.definition_id
      join public.engagements e on e.id = r.engagement_id
      left join public.workflow_steps s on s.id = r.current_step
      order by r.started_at
    `;
    if (runs.length === 0) {
      console.log("  (no runs yet — run demo:reset then tick)");
    }
    for (const r of runs) {
      console.log(
        `  ${String(r.definition).padEnd(28)} ${String(r.engagement ?? "").slice(0, 30).padEnd(32)} ${String(r.status).padEnd(10)} at ${String(r.current_step ?? "—").padEnd(18)} since ${r.started_at.toISOString()}`
      );
    }

    // Spec 4 §2.2: "where is this enquiry in the sequence and why" must be
    // answerable from the ledger alone. This replay reads NOTHING but events.
    console.log("\nWorkflow replay — each run's engagement, from events alone:");
    const replays = await sql`
      with run_engagements as (
        select distinct r.engagement_id, e.title
        from public.workflow_runs r
        join public.engagements e on e.id = r.engagement_id
      )
      select re.title, ev.occurred_at, ev.action, ev.entity_type,
             a.display_name as actor,
             ev.payload ->> 'step_key' as step_key,
             ev.payload ->> 'reason' as reason,
             (ev.payload ->> 'stub')::boolean as stub
      from run_engagements re
      join public.events ev
        on ev.entity_id = re.engagement_id
        or ev.payload ->> 'engagement_id' = re.engagement_id::text
        or ev.entity_id in (
             select r2.id from public.workflow_runs r2 where r2.engagement_id = re.engagement_id
           )
      left join public.actors a on a.id = ev.actor_id
      order by re.title, ev.id
    `;
    let currentTitle = "";
    for (const row of replays) {
      if (row.title !== currentTitle) {
        currentTitle = row.title;
        console.log(`\n  ── ${currentTitle} ──`);
      }
      const detail = [row.step_key, row.reason, row.stub ? "STUB" : null].filter(Boolean).join(" · ");
      console.log(
        `  ${row.occurred_at.toISOString()}  ${String(row.action).padEnd(34)} by ${String(row.actor ?? "?").padEnd(16)}${detail ? ` (${detail})` : ""}`
      );
    }

    console.log("\nEvents ledger (newest first):");
    const events = await sql`
      select e.action, e.entity_type, a.display_name as actor, e.occurred_at
      from public.events e
      join public.actors a on a.id = e.actor_id
      order by e.id desc
      limit 20
    `;
    for (const e of events) {
      console.log(
        `  ${String(e.occurred_at.toISOString()).padEnd(26)} ${String(e.action).padEnd(28)} ${String(e.entity_type ?? "").padEnd(14)} by ${e.actor}`
      );
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("Verification failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
