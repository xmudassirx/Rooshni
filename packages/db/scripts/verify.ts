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
      "events",
      "permission_levels",
      "tools",
      "grants",
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
