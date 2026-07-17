import { loadEnv } from "./env";
import { createServiceClient } from "../src/client";
import { runWorkflowTick } from "../src/workflow";

/**
 * Local workflow tick driver — the founder's watch companion.
 *
 *   npm run tick --workspace=@rooshni/db              one pass
 *   npm run tick:watch --workspace=@rooshni/db        repeat until Ctrl+C
 *
 * In production the same pass runs via GET /api/workflows/tick (Vercel Cron,
 * CRON_SECRET). The poll interval below is infrastructure cadence — how often
 * we LOOK — not a workflow timer; all workflow timing lives in step config
 * scaled through timeScale().
 */

const POLL_INTERVAL_MS = 5000;

function summarise(report: Awaited<ReturnType<typeof runWorkflowTick>>): string {
  const parts: string[] = [];
  if (report.runs_started) parts.push(`${report.runs_started} run(s) started`);
  if (report.steps_completed) parts.push(`${report.steps_completed} step(s) completed`);
  if (report.steps_skipped) parts.push(`${report.steps_skipped} skipped`);
  if (report.steps_awaiting_approval) parts.push(`${report.steps_awaiting_approval} awaiting the stamp`);
  if (report.runs_completed) parts.push(`${report.runs_completed} run(s) completed`);
  if (report.steps_failed) parts.push(`${report.steps_failed} FAILED`);
  return parts.length ? parts.join(", ") : "nothing due";
}

async function main() {
  loadEnv();
  const db = createServiceClient();
  const watch = process.argv.includes("--watch");

  do {
    const report = await runWorkflowTick(db);
    const stamp = new Date().toLocaleTimeString("en-GB");
    console.log(`[${stamp}] tick: ${summarise(report)}`);
    for (const error of report.errors) {
      console.error(`  ERROR ${error}`);
    }
    if (watch) await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  } while (watch);
}

main().catch((err) => {
  console.error("tick failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
