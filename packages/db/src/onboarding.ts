import type { SupabaseClient } from "@supabase/supabase-js";
import { scaleDurationMs } from "@rooshni/config";
import { emitEvent } from "./events";
import { EVENT_KINDS } from "./event-kinds";

/**
 * Session 9 — the pre-active signup lifecycle and payment-time activation
 * (ONBOARDING-HANDOVER rulings 79–84; Lane C rulings of 17 July 2026).
 *
 * The atomic row creation lives in the database doors (0020's
 * activate_signup / delete_unpaid_signup, service-role only); this module
 * orchestrates around them — auth user provisioning, ledger events via
 * emitEvent() (law 11), reminder mail through a caller-supplied seam so the
 * mail provider never leaks into @rooshni/db.
 */

/** The platform system actor (0020) — signs platform-scope account.* events. */
export const PLATFORM_ACTOR_ID = "b0000000-0000-4000-8000-000000000001";

export const PILOT_PLAN = "pilot_firm";

/** decision 82 — the eight First Light predicate keys. The row content
 * itself (titles, copy, the optional flag) lives in activate_signup, the
 * single truth; these keys are for consumers (panel, evaluators, tests). */
export const FIRST_LIGHT_PREDICATE_KEYS = [
  "basics_confirmed",
  "email_calendar_connected",
  "whatsapp_connected",
  "meta_lead_forms_connected",
  "memory_tray_reviewed",
  "nogo_rules_acknowledged",
  "sending_domain_verified",
  "walkthrough_booked",
] as const;

export type FirstLightPredicateKey = (typeof FIRST_LIGHT_PREDICATE_KEYS)[number];

// --- signup (step 1: nothing spent, nothing crawled) -----------------------

export interface CreateSignupInput {
  name: string;
  businessName: string;
  email: string;
  phone: string;
  websiteUrl: string;
}

export interface SignupRecord {
  accountId: string;
  resumeToken: string;
  email: string;
  businessName: string;
}

function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Held from step 1; the crawler session reads it later. Costs nothing. */
function normaliseWebsiteUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Create (or resume) a pre-active signup. Idempotent on the signup email:
 * the same person pressing Continue twice, or coming back a day later, gets
 * their existing pre-active record back — one row per signup, not per click.
 */
export async function createSignup(
  db: SupabaseClient,
  input: CreateSignupInput
): Promise<SignupRecord> {
  const email = normaliseEmail(input.email);
  const name = input.name.trim();
  const businessName = input.businessName.trim();
  if (!name || !businessName || !email.includes("@")) {
    throw new Error("Signup needs a name, a business name and a valid email.");
  }

  const fields = {
    name,
    signup_business_name: businessName,
    signup_email: email,
    signup_phone: input.phone.trim() || null,
    signup_website_url: normaliseWebsiteUrl(input.websiteUrl) || null,
    billing_status: "pre_active",
  };

  const { data: existing, error: lookupError } = await db
    .from("accounts")
    .select("id, signup_resume_token")
    .eq("signup_email", email)
    .eq("billing_status", "pre_active")
    .is("activated_at", null)
    .maybeSingle();
  if (lookupError) throw new Error(`signup lookup failed: ${lookupError.message}`);

  if (existing) {
    const { error } = await db.from("accounts").update(fields).eq("id", existing.id);
    if (error) throw new Error(`signup update failed: ${error.message}`);
    return { accountId: existing.id, resumeToken: existing.signup_resume_token, email, businessName };
  }

  const { data: created, error } = await db
    .from("accounts")
    .insert(fields)
    .select("id, signup_resume_token")
    .single();
  if (error) throw new Error(`signup insert failed: ${error.message}`);
  return { accountId: created.id, resumeToken: created.signup_resume_token, email, businessName };
}

/** The retry door from reminder emails: token → the pre-active record. */
export async function getSignupByResumeToken(
  db: SupabaseClient,
  token: string
): Promise<SignupRecord | null> {
  const { data, error } = await db
    .from("accounts")
    .select("id, signup_resume_token, signup_email, signup_business_name")
    .eq("signup_resume_token", token)
    .eq("billing_status", "pre_active")
    .is("activated_at", null)
    .maybeSingle();
  if (error) throw new Error(`resume lookup failed: ${error.message}`);
  if (!data) return null;
  return {
    accountId: data.id,
    resumeToken: data.signup_resume_token,
    email: data.signup_email,
    businessName: data.signup_business_name,
  };
}

// --- activation (fires ONLY on payment.succeeded — decision 80) ------------

export interface ActivateSignupParams {
  accountId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  /** Minor units, as Stripe reports them (e.g. 14900 = £149.00). */
  amountTotal: number | null;
  currency: string | null;
  /** Stripe's event id — travels into the ledger payload for the audit trail. */
  stripeEventId: string;
}

export interface ActivationResult {
  alreadyActive: boolean;
  businessId: string;
}

async function ensureAuthUser(db: SupabaseClient, email: string): Promise<string> {
  const { data: created, error } = await db.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (!error) return created.user.id;

  // Already registered — find the existing user (the seed's pattern).
  const { data: list, error: listError } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listError) throw new Error(`listUsers failed: ${listError.message}`);
  const existing = list.users.find((u) => u.email?.toLowerCase() === email);
  if (!existing) {
    throw new Error(`createUser failed (${error.message}) and no existing user matches ${email}.`);
  }
  return existing.id;
}

/**
 * Activate a paid signup: provision the auth user (the Google door —
 * Supabase auto-links the Google identity on matching verified email,
 * decision 24), open the activation door, then write the ledger. Idempotent
 * end to end: the door no-ops for an activated account and no events are
 * re-emitted, so a replayed webhook changes nothing.
 */
export async function activateSignup(
  db: SupabaseClient,
  params: ActivateSignupParams
): Promise<ActivationResult> {
  const { data: account, error: accError } = await db
    .from("accounts")
    .select("id, name, plan, signup_email, signup_business_name, activated_at")
    .eq("id", params.accountId)
    .maybeSingle();
  if (accError) throw new Error(`activation lookup failed: ${accError.message}`);
  if (!account) throw new Error(`activation: no account ${params.accountId}`);

  const ownerUserId = await ensureAuthUser(db, account.signup_email);

  const { data: opened, error } = await db.rpc("activate_signup", {
    p_account: params.accountId,
    p_owner_user_id: ownerUserId,
    p_stripe_customer_id: params.stripeCustomerId,
    p_stripe_subscription_id: params.stripeSubscriptionId,
    p_plan: PILOT_PLAN,
  });
  if (error) throw new Error(`activate_signup failed: ${error.message}`);

  const result = opened as {
    already_active: boolean;
    business_id: string;
    owner_actor_id?: string;
    light_actor_id?: string;
    stripe_actor_id?: string;
    grant_ids?: Record<string, string>;
    task_ids?: Record<string, string>;
  };
  if (result.already_active) {
    return { alreadyActive: true, businessId: result.business_id };
  }

  // The firm's first ledger lines — The Record is never empty on day one.
  await emitEvent(db, {
    business_id: result.business_id,
    actor_id: result.stripe_actor_id!,
    action: EVENT_KINDS.accountCreated,
    entity_type: "account",
    entity_id: params.accountId,
    payload: {
      business_name: account.signup_business_name,
      owner: account.name,
      plan: PILOT_PLAN,
    },
  });
  await emitEvent(db, {
    business_id: result.business_id,
    actor_id: result.stripe_actor_id!,
    action: EVENT_KINDS.paymentSucceeded,
    entity_type: "account",
    entity_id: params.accountId,
    payload: {
      amount_total: params.amountTotal,
      currency: params.currency,
      stripe_event_id: params.stripeEventId,
      stripe_customer_id: params.stripeCustomerId,
      stripe_subscription_id: params.stripeSubscriptionId,
    },
  });
  for (const [tool, grantId] of Object.entries(result.grant_ids ?? {})) {
    await emitEvent(db, {
      business_id: result.business_id,
      actor_id: result.owner_actor_id!,
      action: "grant.issued",
      entity_type: "grant",
      entity_id: grantId,
      payload: {
        grantee_actor_id: result.light_actor_id,
        tool,
        access: "execute",
        scope: { level: "business", ref: result.business_id },
        duration: "standing",
        via: "dashboard",
      },
    });
  }

  return { alreadyActive: false, businessId: result.business_id };
}

// --- the pre-active lifecycle sweep (rides the existing cron) ---------------

/** Real-world lifecycle moments (founder-ruled: 24h, 7d, silence, 30d).
 * Scaled through TIME_SCALE at read time like every duration in the system —
 * a compressed clock proves the sweep without waiting a month. */
const REMINDER_24H_MS = 24 * 60 * 60 * 1000;
const REMINDER_7D_MS = 7 * 24 * 60 * 60 * 1000;
const DELETE_30D_MS = 30 * 24 * 60 * 60 * 1000;

export type ReminderKind = "24h" | "7d";

export interface ReminderTarget {
  accountId: string;
  name: string;
  email: string;
  businessName: string;
  resumeToken: string;
}

export interface SweepReport {
  reminded_24h: number;
  reminded_7d: number;
  deleted: number;
  errors: string[];
}

/**
 * One sweep pass: remind at 24h and 7d, hard-delete at 30 days with the
 * platform-scope account.deleted_unpaid event. Mail goes through the
 * caller's seam; a send failure is reported and retried next tick (the
 * sent-at stamp lands only after a successful send).
 */
export async function sweepPreActiveSignups(
  db: SupabaseClient,
  options: {
    sendReminder: (kind: ReminderKind, target: ReminderTarget) => Promise<void>;
    nowMs?: number;
  }
): Promise<SweepReport> {
  const report: SweepReport = { reminded_24h: 0, reminded_7d: 0, deleted: 0, errors: [] };
  const now = options.nowMs ?? Date.now();

  const { data: rows, error } = await db
    .from("accounts")
    .select(
      "id, name, created_at, signup_email, signup_business_name, signup_resume_token, reminder_24h_sent_at, reminder_7d_sent_at"
    )
    .eq("billing_status", "pre_active")
    .is("activated_at", null);
  if (error) {
    report.errors.push(`sweep query failed: ${error.message}`);
    return report;
  }

  for (const row of rows ?? []) {
    const ageMs = now - new Date(row.created_at).getTime();
    const target: ReminderTarget = {
      accountId: row.id,
      name: row.name,
      email: row.signup_email,
      businessName: row.signup_business_name,
      resumeToken: row.signup_resume_token,
    };
    try {
      if (ageMs >= scaleDurationMs(DELETE_30D_MS)) {
        const { data: deleted, error: delError } = await db.rpc("delete_unpaid_signup", {
          p_account: row.id,
        });
        if (delError) throw new Error(`delete_unpaid_signup: ${delError.message}`);
        if (deleted) {
          // Platform scope: no business, no tenant actor — and NO personal
          // data. The ledger is append-only; eventing the deleted record's
          // email would re-retain forever what the ruling just deleted.
          await emitEvent(db, {
            business_id: null,
            actor_id: PLATFORM_ACTOR_ID,
            action: EVENT_KINDS.accountDeletedUnpaid,
            entity_type: "account",
            entity_id: row.id,
            payload: {
              signed_up_at: row.created_at,
              reminded_24h: row.reminder_24h_sent_at !== null,
              reminded_7d: row.reminder_7d_sent_at !== null,
            },
          });
          report.deleted += 1;
        }
      } else if (ageMs >= scaleDurationMs(REMINDER_7D_MS) && !row.reminder_7d_sent_at) {
        await options.sendReminder("7d", target);
        const { error: stampError } = await db
          .from("accounts")
          .update({ reminder_7d_sent_at: new Date(now).toISOString() })
          .eq("id", row.id);
        if (stampError) throw new Error(`7d stamp failed: ${stampError.message}`);
        report.reminded_7d += 1;
      } else if (
        ageMs >= scaleDurationMs(REMINDER_24H_MS) &&
        ageMs < scaleDurationMs(REMINDER_7D_MS) &&
        !row.reminder_24h_sent_at
      ) {
        await options.sendReminder("24h", target);
        const { error: stampError } = await db
          .from("accounts")
          .update({ reminder_24h_sent_at: new Date(now).toISOString() })
          .eq("id", row.id);
        if (stampError) throw new Error(`24h stamp failed: ${stampError.message}`);
        report.reminded_24h += 1;
      }
    } catch (err) {
      report.errors.push(
        `account ${row.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return report;
}
