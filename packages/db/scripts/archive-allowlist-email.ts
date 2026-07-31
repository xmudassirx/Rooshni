import { loadEnv } from "./env";
import { createServiceClient } from "../src/client";
import { emitEvent } from "../src/events";
import { EVENT_KINDS } from "../src/event-kinds";
import { PLATFORM_ACTOR_ID } from "../src/onboarding";

/**
 * Archive an allowed_emails row — the evented sign-in-door close.
 *
 *   npm run allowlist:archive --workspace=@rooshni/db -- <email> "<reason>"
 *
 * Archival is 0018's designed revocation: the RLS policy and the middleware
 * both read only live rows, so setting archived_at shuts the door without
 * losing the record of it having been granted — and nulling it back re-opens
 * the door in one motion. The act lands platform-scope on the ledger
 * (account.allowlist_archived, the 0020 account.* namespace), signed by the
 * platform actor; the payload carries no personal data (the
 * nurture_unsubscribed precedent) — the archived row itself is the record of
 * which email. Refuses emails that resolve to no account: this chore exists
 * for signup-activation rows, and a platform-scope event needs an account to
 * reference.
 */
async function main() {
  const [email, reason] = process.argv.slice(2).filter((a) => a !== "--");
  if (!email || !reason) {
    console.error('usage: npm run allowlist:archive --workspace=@rooshni/db -- <email> "<reason>"');
    process.exit(1);
  }
  loadEnv();
  const db = createServiceClient();
  const normalised = email.trim().toLowerCase();

  const { data: rows, error } = await db
    .from("allowed_emails")
    .select("id, email, note, archived_at")
    .eq("email", normalised)
    .limit(1);
  if (error) throw new Error(`allowlist lookup failed: ${error.message}`);
  if (!rows?.[0]) throw new Error(`No allowed_emails row for ${normalised}.`);
  if (rows[0].archived_at) {
    console.log(`Already archived (${rows[0].archived_at}) — nothing to do.`);
    return;
  }

  const { data: accounts, error: accError } = await db
    .from("accounts")
    .select("id, name, signup_business_name")
    .eq("signup_email", normalised)
    .limit(1);
  if (accError) throw new Error(`account lookup failed: ${accError.message}`);
  if (!accounts?.[0]) {
    throw new Error(
      `No account carries signup_email ${normalised} — refusing: the platform-scope event needs an account to reference.`
    );
  }

  const archivedAt = new Date().toISOString();
  const { error: updError } = await db
    .from("allowed_emails")
    .update({ archived_at: archivedAt })
    .eq("id", rows[0].id)
    .is("archived_at", null);
  if (updError) throw new Error(`archive failed: ${updError.message}`);

  const event = await emitEvent(db, {
    business_id: null,
    actor_id: PLATFORM_ACTOR_ID,
    action: EVENT_KINDS.accountAllowlistArchived,
    entity_type: "account",
    entity_id: accounts[0].id,
    payload: {
      allowed_email_row_id: rows[0].id,
      reason,
    },
  });

  console.log(`Archived allowlist row ${rows[0].id} for account "${accounts[0].name}" at ${archivedAt}.`);
  console.log(`Ledger: ${event.id} (${EVENT_KINDS.accountAllowlistArchived}).`);
}

main().catch((err) => {
  console.error("allowlist:archive failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
