import { loadEnv } from "./env";
import { createServiceClient } from "../src/client";
import { seedMemoryEntries } from "../src/memory-seed";

/**
 * Session 32 (D181) — the memory seed backfill, live runner:
 *
 *   npm run seed:memory --workspace=@rooshni/db
 *
 * For every live business with a template install: today's scattered
 * behaviour becomes memory entries — the fees rule (D179a), the register
 * rule (D142), signature, booking link, phone, opening hours — so day one
 * shows real memory. Runs through the app-side door (createMemoryEntry:
 * evented, judged by the 0044 triggers), NEVER migration SQL (law 11).
 * IDEMPOTENT: a key that has ever existed for a business is skipped — a
 * founder's later edit or deactivation is never argued with. Facts with no
 * value in their pre-D181 home are counted, visible skips.
 *
 * Founder-run (or founder-ordered) AFTER the 0044 live apply and the
 * session merge, at the founder's explicit go.
 */

async function main() {
  loadEnv();
  const db = createServiceClient();

  const { data: businesses, error } = await db
    .from("businesses")
    .select("id, name, template_id")
    .not("template_id", "is", null);
  if (error) throw new Error(`business scan failed: ${error.message}`);

  for (const business of businesses ?? []) {
    // The owner's HUMAN actor — instructions require a human author (0044).
    const { data: membership } = await db
      .from("memberships")
      .select("user_id")
      .eq("business_id", business.id)
      .eq("role", "owner")
      .limit(1)
      .maybeSingle();
    if (!membership) {
      console.log(`SKIP  ${business.name}: no owner membership — no human hand to seed under`);
      continue;
    }
    const { data: owner } = await db
      .from("actors")
      .select("id")
      .eq("user_id", membership.user_id)
      .eq("actor_type", "human")
      .is("archived_at", null)
      .limit(1)
      .maybeSingle();
    if (!owner) {
      console.log(`SKIP  ${business.name}: the owner has no human actor row`);
      continue;
    }

    const report = await seedMemoryEntries(db, {
      business_id: business.id,
      owner_actor_id: owner.id,
    });
    console.log(`${business.name}:`);
    for (const c of report.created) console.log(`  SEEDED  ${c.kind} · ${c.title}`);
    for (const s of report.skipped) console.log(`  SKIP    ${s.key}: ${s.reason}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
