import { loadEnv } from "./env";
import { createServiceClient } from "../src/client";
import { sweepUneventedSupersedes } from "../src/supersede";

/**
 * Session 16 chore — put the 0030 migration's normalisation transitions on
 * The Record. The migration retired older duplicate pendings (newest-wins)
 * with a needs_event marker; SQL never writes the ledger (law 11), so this
 * script events each transition (communication.superseded, reason
 * migration_normalisation) and clears the marker. Idempotent: evented rows
 * are skipped; the cron sweep self-heals any leftovers anyway.
 *
 *   npm run supersede:normalise --workspace=@rooshni/db
 */
async function main() {
  loadEnv();
  const db = createServiceClient();
  const result = await sweepUneventedSupersedes(db);
  console.log(`Evented ${result.evented} supersede transition(s).`);
  for (const err of result.errors) console.error(`  error: ${err}`);
  if (result.errors.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error("supersede:normalise failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
