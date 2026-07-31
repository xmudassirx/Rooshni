import { loadEnv } from "./env";
import { createServiceClient } from "../src/client";
import { emitEvent } from "../src/events";
import { DRAFTING_EVENT_KINDS } from "../src/event-kinds";
import { fetchMetaLead, formAnswersFromFieldData, resolveMetaBusiness } from "../src/meta";
import type { MetaBusinessBinding } from "../src/meta";

/**
 * PR-2 backfill (Session 15, ruled with the C-3 amendment): populate
 * engagements.attributes.form_answers on shadow-era enquiries from the
 * webhook events 0021 retained.
 *
 *   npm run backfill:form-answers --workspace=@rooshni/db
 *
 * IDEMPOTENT (C-3 amendment): an enquiry already holding form_answers is
 * skipped, so the chore runs twice — once in-session, once post-merge to
 * catch leads ingested in the gap — and each run reports its own counts.
 *
 * Egress discipline, better than the ruling asked: the stored payloads hold
 * ids only (Session 10 fetched field data live and never persisted it), so
 * this chore never reads the payload column at all — it reads the indexed
 * id columns, then fetches each lead's field data from Graph ONCE by its
 * stored leadgen id (leads_retrieval, the live-path adapter re-used). A
 * lead Meta no longer serves (their ~90-day retention) is a counted,
 * visible failure, never a silent skip.
 */

const OUTCOME_RE = /^(?:ingested|duplicate): engagement ([0-9a-f-]{36})/;

async function main() {
  loadEnv();
  const accessToken = process.env.META_ACCESS_TOKEN;
  if (!accessToken) {
    console.error("META_ACCESS_TOKEN is not set — the backfill fetches field data from Graph.");
    process.exit(1);
  }
  const db = createServiceClient();

  // 1. The retained webhook marks — id columns only, never the payload.
  const { data: marks, error: marksError } = await db
    .from("meta_webhook_events")
    .select("leadgen_id, page_id, outcome")
    .or("outcome.like.ingested:*,outcome.like.duplicate:*");
  if (marksError) throw new Error(`meta_webhook_events scan failed: ${marksError.message}`);

  // Duplicates point at the same engagement as their original — keep the
  // first leadgen id seen per engagement.
  const byEngagement = new Map<string, { leadgen_id: string; page_id: string | null }>();
  for (const mark of marks ?? []) {
    const m = OUTCOME_RE.exec(mark.outcome ?? "");
    if (!m) continue;
    if (!byEngagement.has(m[1]!)) {
      byEngagement.set(m[1]!, { leadgen_id: mark.leadgen_id, page_id: mark.page_id });
    }
  }
  const scanned = byEngagement.size;
  if (scanned === 0) {
    console.log("No ingested Meta enquiries found — nothing to backfill.");
    return;
  }

  // 2. Which of those enquiries still lack form_answers? (Idempotency.)
  const ids = [...byEngagement.keys()];
  const { data: engagements, error: engError } = await db
    .from("engagements")
    .select("id, business_id, attributes")
    .in("id", ids);
  if (engError) throw new Error(`engagements lookup failed: ${engError.message}`);

  const pending = (engagements ?? []).filter((e) => {
    const attrs = (e.attributes ?? {}) as Record<string, unknown>;
    return !Array.isArray(attrs.form_answers);
  });
  const alreadyHad = (engagements ?? []).length - pending.length;

  // 3. Bindings resolved once per page (the integration actor attributes the
  // evented write, as it attributed the original ingest).
  const bindings = new Map<string, MetaBusinessBinding>();
  let backfilled = 0;
  const failures: Array<{ engagement_id: string; reason: string }> = [];

  for (const engagement of pending) {
    const mark = byEngagement.get(engagement.id)!;
    try {
      if (!mark.page_id) throw new Error("webhook mark carries no page_id");
      let binding = bindings.get(mark.page_id);
      if (!binding) {
        binding = await resolveMetaBusiness(db, mark.page_id);
        bindings.set(mark.page_id, binding);
      }

      // One Graph read per lead, ever.
      const lead = await fetchMetaLead(mark.leadgen_id, accessToken);
      const formAnswers = formAnswersFromFieldData(lead.field_data);

      const attrs = (engagement.attributes ?? {}) as Record<string, unknown>;
      const { error: updError } = await db
        .from("engagements")
        .update({ attributes: { ...attrs, form_answers: formAnswers } })
        .eq("id", engagement.id);
      if (updError) throw new Error(`attributes update failed: ${updError.message}`);

      await emitEvent(db, {
        business_id: engagement.business_id,
        actor_id: binding.integration_actor_id,
        action: DRAFTING_EVENT_KINDS.formAnswersBackfilled,
        entity_type: "engagement",
        entity_id: engagement.id,
        payload: { lead_id: mark.leadgen_id, answers: formAnswers.length },
      });
      backfilled += 1;
    } catch (err) {
      failures.push({
        engagement_id: engagement.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log(`Backfill report:`);
  console.log(`  enquiries with a stored Meta mark : ${scanned}`);
  console.log(`  already holding form_answers      : ${alreadyHad} (skipped — idempotent)`);
  console.log(`  backfilled this run               : ${backfilled} (each evented: ${DRAFTING_EVENT_KINDS.formAnswersBackfilled})`);
  console.log(`  failed                            : ${failures.length}`);
  for (const failure of failures) {
    console.log(`    ${failure.engagement_id}: ${failure.reason}`);
  }
}

main().catch((err) => {
  console.error("backfill:form-answers failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
