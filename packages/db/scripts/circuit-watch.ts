import { readFileSync, writeFileSync } from "node:fs";
import { loadEnv } from "./env";
import { createServiceClient } from "../src/client";

/**
 * DoD circuit watch (Session 10) — one polling pass: print every NEW webhook
 * claim and circuit-relevant ledger event since the cursor, then advance the
 * cursor. Driven in a loop by the session monitor; read-only except for the
 * cursor file named in CIRCUIT_CURSOR_FILE.
 */
const ACTIONS = [
  "meta.lead_received",
  "engagement.created",
  "contact.created",
  "communication.drafted",
  "communication.submitted",
  "communication.approved",
  "communication.rejected",
  "communication.sent",
  "communication.send_failed",
  "communication.queued_quiet_hours",
  "workflow.run_started",
  "workflow.step_awaiting_approval",
  "workflow.step_skipped",
  "workflow.auto_close_refused",
  "engagement.stage_changed",
];

async function main() {
  loadEnv();
  const cursorFile = process.env.CIRCUIT_CURSOR_FILE;
  if (!cursorFile) throw new Error("CIRCUIT_CURSOR_FILE is not set");
  const cursor = readFileSync(cursorFile, "utf8").trim();
  const db = createServiceClient();
  let max = cursor;

  const { data: claims, error: claimErr } = await db
    .from("meta_webhook_events")
    .select("leadgen_id, outcome, updated_at")
    .gt("updated_at", cursor)
    .not("leadgen_id", "like", "sig_rejected%")
    .neq("leadgen_id", "444400000000000099")
    .order("updated_at", { ascending: true });
  if (claimErr) throw new Error(claimErr.message);
  for (const c of claims ?? []) {
    console.log(`WEBHOOK lead ${c.leadgen_id} -> ${c.outcome ?? "claimed, processing"}`);
    if (c.updated_at > max) max = c.updated_at;
  }

  const { data: evts, error: evtErr } = await db
    .from("events")
    .select("action, entity_id, occurred_at, payload")
    .in("action", ACTIONS)
    .gt("occurred_at", cursor)
    .order("occurred_at", { ascending: true })
    .limit(40);
  if (evtErr) throw new Error(evtErr.message);
  for (const e of evts ?? []) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const extra =
      e.action === "communication.rejected"
        ? ` reason=${String(p.reason ?? "").slice(0, 60)}`
        : e.action === "communication.sent"
        ? ` provider=${p.provider} msgid=${p.provider_message_id}`
        : e.action === "communication.send_failed"
          ? ` reason=${p.reason}`
          : e.action === "workflow.step_awaiting_approval"
            ? ` step=${p.step_key}`
            : e.action === "workflow.step_skipped"
              ? ` step=${p.step_key} reason=${String(p.reason ?? "").slice(0, 90)}`
              : e.action === "engagement.stage_changed"
                ? ` to=${p.to_stage}`
                : "";
    console.log(`LEDGER ${e.action} ${String(e.entity_id ?? "").slice(-8)}${extra}`);
    if (e.occurred_at > max) max = e.occurred_at;
  }

  writeFileSync(cursorFile, max);
}

main().catch((e) => {
  console.log(`WATCH-ERROR ${e instanceof Error ? e.message : e}`);
});
