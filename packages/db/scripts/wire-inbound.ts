import { loadEnv } from "./env";
import { createServiceClient } from "../src/client";

/**
 * Bind the inbound doors to a business (Session 16, PR-A). The WhatsApp
 * webhook resolves the tenant by businesses.settings.whatsapp.phone_number_id;
 * the Graph inbound poll by businesses.settings.graph.mailbox — exactly one
 * business per binding, the wire-meta pattern.
 *
 *   npm run wire-inbound --workspace=@rooshni/db -- \
 *     [--whatsapp <phone_number_id>] [--mailbox <address>] [business_id]
 *
 * With one business in the database the id can be omitted. Config, not a
 * secret — the phone-number id and mailbox address are not credentials.
 */
async function main() {
  loadEnv();
  const args = process.argv.slice(2).filter((a) => a !== "--");
  let whatsapp: string | null = null;
  let mailbox: string | null = null;
  let businessArg: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--whatsapp") whatsapp = args[++i] ?? null;
    else if (args[i] === "--mailbox") mailbox = args[++i] ?? null;
    else businessArg = args[i] ?? null;
  }
  if (!whatsapp && !mailbox) {
    console.error(
      "Usage: npm run wire-inbound --workspace=@rooshni/db -- [--whatsapp <phone_number_id>] [--mailbox <address>] [business_id]"
    );
    process.exit(1);
  }
  if (whatsapp && !/^\d+$/.test(whatsapp)) {
    console.error("--whatsapp expects the numeric WhatsApp phone-number id (not the display number).");
    process.exit(1);
  }

  const db = createServiceClient();
  const { data: businesses, error } = await db
    .from("businesses")
    .select("id, name, settings")
    .is("archived_at", null);
  if (error) throw new Error(`business lookup failed: ${error.message}`);
  const target = businessArg
    ? businesses?.find((b) => b.id === businessArg)
    : businesses?.length === 1
      ? businesses[0]
      : undefined;
  if (!target) {
    console.error(
      businessArg
        ? `Business ${businessArg} not found.`
        : `${businesses?.length ?? 0} businesses exist — name one: npm run wire-inbound -- [flags] <business_id>`
    );
    for (const b of businesses ?? []) console.error(`  ${b.id}  ${b.name}`);
    process.exit(1);
  }

  const settings = (target.settings ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...settings };
  if (whatsapp) {
    next.whatsapp = { ...((settings.whatsapp as Record<string, unknown>) ?? {}), phone_number_id: whatsapp };
  }
  if (mailbox) {
    next.graph = { ...((settings.graph as Record<string, unknown>) ?? {}), mailbox: mailbox.toLowerCase() };
  }
  const { error: updateError } = await db.from("businesses").update({ settings: next }).eq("id", target.id);
  if (updateError) throw new Error(`settings update failed: ${updateError.message}`);
  if (whatsapp) console.log(`Bound WhatsApp number ${whatsapp} → business "${target.name}" (${target.id}).`);
  if (mailbox) console.log(`Bound mailbox ${mailbox.toLowerCase()} → business "${target.name}" (${target.id}).`);
}

main().catch((err) => {
  console.error("wire-inbound failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
