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
    ];

    console.log("Row counts:");
    for (const table of tables) {
      const [row] = await sql`select count(*)::int as n from ${sql("public." + table)}`;
      console.log(`  ${table.padEnd(20)} ${row?.n ?? 0}`);
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
