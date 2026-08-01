import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import {
  createServiceClient,
  recordInboundWhatsApp,
  resolveInboundBusiness,
  verifyMetaSignature,
} from "@rooshni/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The WhatsApp Cloud API inbound webhook (Session 16, PR-A) — a client's
 * WhatsApp message becomes a communications row (direction inbound), opens
 * the 24h service window on its thread, and refreshes channel consent.
 *
 * Discipline (the /api/meta/leads route, verbatim): FAIL CLOSED — no
 * configured app secret, no processing; X-Hub-Signature-256 verified against
 * the RAW body before parsing; a rejected probe leaves a mark. Idempotent on
 * WhatsApp's message id (wa_webhook_events unique index) — Meta retries
 * webhooks, and a replay changes nothing.
 *
 * This route may create Level 2 rows (contacts, channels, threads,
 * inbound communications) under the integration actor. It can NEVER
 * approve, publish or send — the human-stamp triggers apply identically.
 */

interface WaWebhookMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
}

interface WaWebhookValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
  messages?: WaWebhookMessage[];
  statuses?: unknown[];
}

interface WaWebhookBody {
  object?: string;
  entry?: Array<{
    id: string;
    changes?: Array<{ field?: string; value?: WaWebhookValue }>;
  }>;
}

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

/** Non-text messages become a stated placeholder body — the row is honest
 * about what arrived without pretending to carry media bytes (decision 59:
 * never our bytes). */
function bodyFor(message: WaWebhookMessage): string {
  if (message.type === "text") return message.text?.body ?? "";
  return `[${message.type ?? "unsupported"} message received on WhatsApp — media is viewable in WhatsApp]`;
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
    await db.from("wa_webhook_events").insert({
      wamid: `sig_rejected_${crypto.randomUUID()}`,
      payload: {},
      processed_at: new Date().toISOString(),
      outcome: `rejected: ${verdict.reason}`,
    });
    return NextResponse.json({ ok: false, detail: "signature verification failed" }, { status: 400 });
  }

  let body: WaWebhookBody;
  try {
    body = JSON.parse(rawBody) as WaWebhookBody;
  } catch {
    return NextResponse.json({ ok: false, detail: "unparseable body" }, { status: 400 });
  }
  if (body.object !== "whatsapp_business_account" || !Array.isArray(body.entry)) {
    return NextResponse.json({ ok: true, detail: "not a WhatsApp Business delivery — ignored" });
  }

  const errors: string[] = [];
  let ingested = 0;

  for (const entry of body.entry) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages" || !change.value) continue;
      const value = change.value;
      // Delivery/read receipts (value.statuses) are decision 103's future
      // tightening, not this session's scope — acknowledged, not processed.
      const phoneNumberId = value.metadata?.phone_number_id ?? "";

      for (const message of value.messages ?? []) {
        if (!message.id || !message.from) continue;

        // Idempotency claim on the wamid — Meta retries webhooks; a replay
        // of a processed message changes nothing, a failed claim retries.
        const { error: claimError } = await db.from("wa_webhook_events").insert({
          wamid: message.id,
          phone_number_id: phoneNumberId,
          payload: message as unknown as Record<string, unknown>,
        });
        if (claimError) {
          if (claimError.code !== "23505") {
            errors.push(`message ${message.id}: claim failed: ${claimError.message}`);
            continue;
          }
          const { data: existing } = await db
            .from("wa_webhook_events")
            .select("processed_at, outcome")
            .eq("wamid", message.id)
            .maybeSingle();
          if (existing?.processed_at && !existing.outcome?.startsWith("error")) {
            continue; // duplicate — already processed; replay changes nothing.
          }
        }
        const stamp = async (outcome: string) => {
          await db
            .from("wa_webhook_events")
            .update({ processed_at: new Date().toISOString(), outcome })
            .eq("wamid", message.id);
        };

        try {
          const binding = await resolveInboundBusiness(db, { whatsapp_phone_number_id: phoneNumberId });
          const profileName =
            value.contacts?.find((c) => c.wa_id === message.from)?.profile?.name ??
            value.contacts?.[0]?.profile?.name ??
            null;
          const result = await recordInboundWhatsApp(db, binding, {
            phone_number_id: phoneNumberId,
            wamid: message.id,
            from: message.from,
            profile_name: profileName,
            body: bodyFor(message),
            wa_type: message.type ?? "unknown",
            occurred_at: message.timestamp
              ? new Date(Number(message.timestamp) * 1000).toISOString()
              : new Date().toISOString(),
          });
          ingested += 1;
          await stamp(`ingested: communication ${result.communication_id}`);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          errors.push(`message ${message.id}: ${detail}`);
          await stamp(`error: ${detail}`);
        }
      }
    }
  }

  if (errors.length > 0) {
    // 500 → Meta retries; claims and the ingest are idempotent, so a retry
    // after a transient failure (or once the binding is wired) is safe.
    return NextResponse.json({ ok: false, detail: errors }, { status: 500 });
  }
  return NextResponse.json({ ok: true, ingested });
}
