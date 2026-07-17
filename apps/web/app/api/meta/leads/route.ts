import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import {
  createServiceClient,
  fetchMetaLead,
  ingestMetaLead,
  resolveMetaBusiness,
  runWorkflowTick,
  verifyMetaSignature,
  type MetaLeadgenWebhookBody,
} from "@rooshni/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The Meta Lead Forms webhook (Session 10) — a real inbound lead becomes
 * contact + consent + enquiry at "New" + Conversations thread, and the
 * meta_lead_to_consultation workflow starts, all without a manual nudge.
 *
 * Discipline (the Session 9 stripe_events precedent, verbatim):
 *   FAIL CLOSED — no configured app secret, no processing. The
 *   X-Hub-Signature-256 header is verified against the RAW body before the
 *   payload is even parsed; a rejected probe leaves a mark. Idempotent on
 *   Meta's leadgen id (meta_webhook_events unique index claims each lead;
 *   the engagement's external_refs guard backs it) — Meta retries webhooks,
 *   and a replay changes nothing.
 *
 * The webhook may create Level 2 rows (contacts, enquiries, threads) under
 * the integration actor's grant. It can NEVER approve, publish or send —
 * the human-stamp triggers apply to integration code identically.
 */

/** GET — Meta's verify-token handshake at subscription time. */
export async function GET(request: NextRequest) {
  const verifyToken = process.env.META_VERIFY_TOKEN;
  if (!verifyToken) {
    return NextResponse.json(
      { ok: false, detail: "META_VERIFY_TOKEN is not configured — the webhook is closed." },
      { status: 503 }
    );
  }
  const params = request.nextUrl.searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token") ?? "";
  const challenge = params.get("hub.challenge") ?? "";
  const a = Buffer.from(token);
  const b = Buffer.from(verifyToken);
  if (mode === "subscribe" && a.length === b.length && timingSafeEqual(a, b)) {
    return new NextResponse(challenge, { status: 200 });
  }
  return NextResponse.json({ ok: false }, { status: 403 });
}

export async function POST(request: NextRequest) {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    return NextResponse.json(
      { ok: false, detail: "META_APP_SECRET is not configured — the webhook is closed." },
      { status: 503 }
    );
  }

  const rawBody = await request.text();
  const verdict = verifyMetaSignature({
    payload: rawBody,
    header: request.headers.get("x-hub-signature-256"),
    secret: appSecret,
  });

  const db = createServiceClient();

  if (!verdict.ok) {
    // An unverified body is untrusted input: none of it is parsed or stored.
    // The rejection itself is recorded — a probe leaves a mark.
    await db.from("meta_webhook_events").insert({
      leadgen_id: `sig_rejected_${crypto.randomUUID()}`,
      payload: {},
      processed_at: new Date().toISOString(),
      outcome: `rejected: ${verdict.reason}`,
    });
    return NextResponse.json({ ok: false, detail: "signature verification failed" }, { status: 400 });
  }

  let body: MetaLeadgenWebhookBody;
  try {
    body = JSON.parse(rawBody) as MetaLeadgenWebhookBody;
  } catch {
    return NextResponse.json({ ok: false, detail: "unparseable body" }, { status: 400 });
  }
  if (body.object !== "page" || !Array.isArray(body.entry)) {
    return NextResponse.json({ ok: true, detail: "not a page/leadgen delivery — ignored" });
  }

  const accessToken = process.env.META_ACCESS_TOKEN;
  const errors: string[] = [];
  let ingested = 0;

  for (const entry of body.entry) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "leadgen" || !change.value?.leadgen_id) continue;
      const leadgenId = change.value.leadgen_id;
      const pageId = change.value.page_id ?? entry.id;

      // Idempotency on the provider's id: the insert claims the lead. A
      // replay hits the unique index — a successfully processed lead is
      // acknowledged as a duplicate; a claim whose processing failed falls
      // through and is retried (the ingest itself is idempotent too).
      const { error: claimError } = await db.from("meta_webhook_events").insert({
        leadgen_id: leadgenId,
        page_id: pageId,
        payload: change.value as unknown as Record<string, unknown>,
      });
      if (claimError) {
        if (claimError.code !== "23505") {
          errors.push(`lead ${leadgenId}: claim failed: ${claimError.message}`);
          continue;
        }
        const { data: existing } = await db
          .from("meta_webhook_events")
          .select("processed_at, outcome")
          .eq("leadgen_id", leadgenId)
          .maybeSingle();
        if (existing?.processed_at && !existing.outcome?.startsWith("error")) {
          continue; // duplicate — already processed; replay changes nothing.
        }
        // Claimed earlier but never completed — fall through and retry.
      }

      const stamp = async (outcome: string) => {
        await db
          .from("meta_webhook_events")
          .update({ processed_at: new Date().toISOString(), outcome })
          .eq("leadgen_id", leadgenId);
      };

      try {
        if (!accessToken) {
          throw new Error("META_ACCESS_TOKEN is not configured — cannot fetch the lead's field data");
        }
        const binding = await resolveMetaBusiness(db, pageId);
        const lead = await fetchMetaLead(leadgenId, accessToken);
        const result = await ingestMetaLead(db, binding, lead);
        if (result.created) {
          ingested += 1;
          await stamp(`ingested: engagement ${result.engagement_id}`);
        } else {
          await stamp(`duplicate: engagement ${result.engagement_id} already exists`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`lead ${leadgenId}: ${message}`);
        await stamp(`error: ${message}`);
      }
    }
  }

  // Kick the workflow so the lead's first step fires without waiting for the
  // next cron tick. Best-effort: the claim above is already safe — a tick
  // failure here is retried by the cron, never by Meta.
  if (ingested > 0) {
    try {
      await runWorkflowTick(db);
    } catch (err) {
      errors.push(`post-ingest tick: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (errors.length > 0) {
    // 500 → Meta retries; claims and ingest are idempotent, so a retry
    // after a transient failure is safe.
    return NextResponse.json({ ok: false, detail: errors }, { status: 500 });
  }
  return NextResponse.json({ ok: true, ingested });
}
