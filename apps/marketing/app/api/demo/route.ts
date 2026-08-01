import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient, emitEvent, normalisePhone, type SupabaseClient } from "@rooshni/db";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * The demo-request door (Session 17) — the marketing site's ONE write path
 * into the product database. A submitted form becomes contact + enquiry at
 * "New" in the BarakahX business's own pipeline, evented via emitEvent().
 *
 * Discipline:
 *  - Server-side only, service key; the browser never touches Supabase.
 *  - FAIL CLOSED: no MARKETING_DEMO_BUSINESS_ID or Supabase secrets, no
 *    processing (503) — misconfiguration is loud, never a silent drop.
 *  - Honeypot field ("website"): filled means bot; acknowledged and dropped.
 *  - Rate limited per IP (in-memory sliding window; per-instance best effort
 *    on serverless — the honeypot and validation are the primary gates).
 *  - This route may create Level 2 rows only. It can NEVER approve, publish
 *    or send — the product's human-stamp triggers apply to it identically.
 *
 * JUDGMENT: rows attribute to the account's workflow actor (the decision
 * 93/106 precedent — marketing intake is platform automation; exactly one
 * workflow actor per account, ambiguity is a loud failure). Listed in the
 * Session 17 close report.
 */

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // wall-clock abuse window, not a workflow timer
const MAX_BODY_BYTES = 16 * 1024;

const submissionLog = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const seen = (submissionLog.get(ip) ?? []).filter((t) => t > cutoff);
  if (seen.length >= RATE_LIMIT_MAX) {
    submissionLog.set(ip, seen);
    return true;
  }
  seen.push(now);
  submissionLog.set(ip, seen);
  return false;
}

interface DemoRequestBody {
  name?: string;
  firm?: string;
  email?: string;
  phone?: string;
  message?: string;
  website?: string; // honeypot
}

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function q<T>(
  p: PromiseLike<{ data: T | null; error: { message: string } | null }>,
  what: string
): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  return (data ?? ([] as unknown)) as T;
}

/** The BarakahX tenant's binding, resolved fresh per request: the business
 * row, its template, and the account's single workflow actor. Anything
 * missing or ambiguous throws — a misconfigured door stays shut, loudly. */
async function resolveDemoBusiness(db: SupabaseClient, businessId: string) {
  const businesses = await q<{ id: string; account_id: string; template_id: string | null }[]>(
    db
      .from("businesses")
      .select("id, account_id, template_id")
      .eq("id", businessId)
      .is("archived_at", null)
      .limit(1),
    "demo business lookup"
  );
  if (!businesses[0]) throw new Error(`MARKETING_DEMO_BUSINESS_ID ${businessId} matches no live business`);
  const business = businesses[0];
  if (!business.template_id) throw new Error(`Business ${businessId} has no installed template`);

  const actors = await q<{ id: string }[]>(
    db
      .from("actors")
      .select("id")
      .eq("account_id", business.account_id)
      .eq("actor_type", "workflow")
      .is("archived_at", null),
    "workflow actor lookup"
  );
  if (actors.length !== 1) {
    throw new Error(`Account for business ${businessId} holds ${actors.length} workflow actors — exactly one is required`);
  }

  const owners = await q<{ owner_user_id: string }[]>(
    db.from("accounts").select("owner_user_id").eq("id", business.account_id).limit(1),
    "account lookup"
  );
  if (!owners[0]) throw new Error(`Account for business ${businessId} not found`);
  const ownerActors = await q<{ id: string }[]>(
    db
      .from("actors")
      .select("id")
      .eq("account_id", business.account_id)
      .eq("actor_type", "human")
      .eq("user_id", owners[0].owner_user_id)
      .is("archived_at", null)
      .limit(1),
    "owner actor lookup"
  );
  if (!ownerActors[0]) throw new Error(`Owner actor for business ${businessId} not found`);

  return {
    business_id: business.id,
    template_id: business.template_id,
    actor_id: actors[0]!.id,
    owner_actor_id: ownerActors[0]!.id,
  };
}

export async function POST(request: NextRequest) {
  // Cheap gates first: size, shape, honeypot, rate — no secrets involved.
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, detail: "Request too large." }, { status: 413 });
  }
  let body: DemoRequestBody;
  try {
    body = JSON.parse(rawBody) as DemoRequestBody;
  } catch {
    return NextResponse.json({ ok: false, detail: "Unreadable request." }, { status: 400 });
  }

  // Honeypot: a human never sees this field. Acknowledge and create nothing.
  if (clean(body.website, 200) !== "") {
    return NextResponse.json({ ok: true });
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (rateLimited(ip)) {
    return NextResponse.json(
      { ok: false, detail: "Too many requests from this connection. Try again later." },
      { status: 429 }
    );
  }

  const name = clean(body.name, 200);
  const firm = clean(body.firm, 200);
  const email = clean(body.email, 320).toLowerCase();
  const phone = normalisePhone(clean(body.phone, 40));
  const message = clean(body.message, 2000);

  if (!name || !firm || !email) {
    return NextResponse.json(
      { ok: false, detail: "Name, firm and email are required." },
      { status: 422 }
    );
  }
  if (!EMAIL_SHAPE.test(email)) {
    return NextResponse.json(
      { ok: false, detail: "That email address does not look deliverable." },
      { status: 422 }
    );
  }

  // Configuration gates: fail closed, loudly.
  const businessId = process.env.MARKETING_DEMO_BUSINESS_ID;
  if (!businessId || !process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    return NextResponse.json(
      { ok: false, detail: "The demo desk is not configured yet. Email us instead." },
      { status: 503 }
    );
  }

  try {
    const db = createServiceClient();
    const binding = await resolveDemoBusiness(db, businessId);
    const submittedAt = new Date().toISOString();
    const [givenName, ...familyParts] = name.split(/\s+/);

    // The enquiry type and its "New" stage, resolved by key (semantic set).
    const types = await q<{ id: string }[]>(
      db
        .from("engagement_types")
        .select("id")
        .eq("template_id", binding.template_id)
        .eq("key", "enquiry")
        .is("archived_at", null)
        .limit(1),
      "engagement type lookup"
    );
    if (!types[0]) throw new Error(`No "enquiry" engagement type on template ${binding.template_id}`);
    const stages = await q<{ id: string }[]>(
      db
        .from("stage_definitions")
        .select("id")
        .eq("engagement_type_id", types[0].id)
        .eq("key", "new_lead")
        .is("archived_at", null)
        .limit(1),
      "new_lead stage lookup"
    );
    if (!stages[0]) throw new Error(`No "new_lead" stage on the enquiry type`);

    const attribution = { source: "marketing_site", form: "demo_request" };

    // 1. Contact + channels. Consent is what the form actually grants: a
    // reply about this request (transactional), nothing more.
    const consent = {
      marketing: false,
      transactional: true,
      granted_at: submittedAt,
      source: "marketing_site_demo_form",
    };
    const contacts = await q<{ id: string }[]>(
      db
        .from("contacts")
        .insert({
          business_id: binding.business_id,
          created_by: binding.actor_id,
          type: "person",
          display_name: name,
          given_name: givenName,
          family_name: familyParts.join(" ") || null,
          status: "active",
          first_touch: { source: "marketing_site", form: "demo_request", occurred_at: submittedAt },
          locale: "en-GB",
        })
        .select("id"),
      "contact insert"
    );
    const contactId = contacts[0]!.id;

    for (const channel of [
      { channel: "email", value: email },
      { channel: "phone", value: phone },
    ]) {
      if (!channel.value) continue;
      await q(
        db
          .from("contact_channels")
          .insert({
            business_id: binding.business_id,
            created_by: binding.actor_id,
            contact_id: contactId,
            channel: channel.channel,
            value: channel.value,
            is_primary: true,
            consent,
          })
          .select("id"),
        "contact_channels insert"
      );
    }

    await emitEvent(db, {
      business_id: binding.business_id,
      actor_id: binding.actor_id,
      action: "contact.created",
      entity_type: "contact",
      entity_id: contactId,
      payload: { source: "marketing_site", form: "demo_request", display_name: name },
    });

    // 2. Enquiry at "New". The enquirer's own words persist as declared
    // form answers (the PR-2 shape) and render in context-in-card.
    const formAnswers = [
      { name: "firm_name", label: "Firm name", value: firm },
      { name: "demo_request", label: "What the demo should cover", value: message || "(nothing specific)" },
    ];
    const engagements = await q<{ id: string }[]>(
      db
        .from("engagements")
        .insert({
          business_id: binding.business_id,
          created_by: binding.actor_id,
          template_type_id: types[0].id,
          title: `${firm}: demo request`,
          stage_id: stages[0].id,
          stage_entered_at: submittedAt,
          attribution,
          owner_actor_id: binding.owner_actor_id,
          attributes: { form_answers: formAnswers },
        })
        .select("id"),
      "engagement insert"
    );
    const engagementId = engagements[0]!.id;

    await q(
      db
        .from("engagement_participants")
        .insert({
          business_id: binding.business_id,
          created_by: binding.actor_id,
          engagement_id: engagementId,
          contact_id: contactId,
          role: "client",
        })
        .select("id"),
      "participant insert"
    );

    await q(
      db
        .from("stage_history")
        .insert({
          business_id: binding.business_id,
          engagement_id: engagementId,
          from_stage: null,
          to_stage: stages[0].id,
          moved_at: submittedAt,
          moved_by: binding.actor_id,
        })
        .select("id"),
      "stage_history insert"
    );

    // 3. The Conversations thread the founder replies on. No communications
    // row is created: this route never writes the comms table, so nothing it
    // does can trigger drafting or touch the approval pipeline.
    await q(
      db
        .from("comm_threads")
        .insert({
          business_id: binding.business_id,
          created_by: binding.actor_id,
          contact_id: contactId,
          engagement_id: engagementId,
          channel: "email",
          subject: `${firm}: demo request`,
        })
        .select("id"),
      "thread insert"
    );

    await emitEvent(db, {
      business_id: binding.business_id,
      actor_id: binding.actor_id,
      action: "engagement.created",
      entity_type: "engagement",
      entity_id: engagementId,
      payload: { stage: "new_lead", attribution },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("demo request failed:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { ok: false, detail: "We could not record your request just now. Try again shortly." },
      { status: 500 }
    );
  }
}
