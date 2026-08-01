import { loadEnv } from "./env";
import { createServiceClient } from "../src/client";
import { createGraphInboundReader } from "../src/graph";

/**
 * Session 16 — the staged circuit pre-check (DoD deferred by the founder:
 * build everything, stage the circuit). READ-ONLY against live: reports
 * whether each precondition of the witnessed circuit holds, and names the
 * exact missing act when one does not. Sends nothing, writes nothing.
 *
 *   npm run circuit:supersede --workspace=@rooshni/db
 */
async function main() {
  loadEnv();
  const db = createServiceClient();
  const notes: string[] = [];
  const ok = (label: string, pass: boolean, detail: string) => {
    console.log(`  ${pass ? "READY" : "MISSING"}  ${label}${detail ? ` — ${detail}` : ""}`);
    if (!pass) notes.push(label);
  };

  console.log("Session 16 circuit pre-check:\n");

  // 1. Env keys the engine and doors need.
  ok("ANTHROPIC_API_KEY", Boolean(process.env.ANTHROPIC_API_KEY), "reply drafting fails visibly without it");
  ok("META_APP_SECRET + META_VERIFY_TOKEN", Boolean(process.env.META_APP_SECRET && process.env.META_VERIFY_TOKEN), "the WhatsApp webhook fails closed without them");
  ok("CRON_SECRET", Boolean(process.env.CRON_SECRET), "the tick endpoint is closed without it");

  // 2. The inbound bindings (wire-inbound).
  const { data: businesses, error } = await db
    .from("businesses")
    .select("id, name, settings")
    .is("archived_at", null);
  if (error) throw new Error(`business read failed: ${error.message}`);
  const waBound = (businesses ?? []).filter((b) => (b.settings as Record<string, { phone_number_id?: string }>)?.whatsapp?.phone_number_id);
  const mailBound = (businesses ?? []).filter((b) => (b.settings as Record<string, { mailbox?: string }>)?.graph?.mailbox);
  ok(
    "WhatsApp number binding (settings.whatsapp.phone_number_id)",
    waBound.length === 1,
    waBound.length === 1
      ? `bound to "${waBound[0]!.name}"`
      : `${waBound.length} bindings — run: npm run wire-inbound -- --whatsapp <phone_number_id> <business_id>`
  );
  ok(
    "Mailbox binding (settings.graph.mailbox)",
    mailBound.length === 1,
    mailBound.length === 1
      ? `bound to "${mailBound[0]!.name}"`
      : `${mailBound.length} bindings — run: npm run wire-inbound -- --mailbox <address> <business_id>`
  );

  // 3. Graph inbound read (the Mail.Read consent gap surfaces here).
  const reader = createGraphInboundReader();
  if (!reader) {
    ok("Graph inbound reader", false, "AZURE_* / GRAPH_SENDER_ADDRESS not configured");
  } else {
    try {
      await reader.listNewMessages(new Date(Date.now() - 60_000).toISOString(), 1);
      ok("Graph Mail.Read consent", true, `inbox of ${reader.mailbox} is readable`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ok(
        "Graph Mail.Read consent",
        false,
        /Authorization_RequestDenied|ErrorAccessDenied|Access is denied|403/i.test(message)
          ? "the app registration lacks Mail.Read (application) or admin consent — see the close report's console steps"
          : message
      );
    }
  }

  // 4. The realtime publication: pg_publication is not readable over the
  // API — the 0031 live apply is its verification; stated so this checklist
  // is honest about its reach.
  console.log("  NOTE    supabase_realtime publication — verified by the 0031 live apply, not readable over the API");

  console.log(
    notes.length === 0
      ? "\nAll preconditions READY — the witnessed circuit can run."
      : `\n${notes.length} precondition(s) MISSING:\n  - ${notes.join("\n  - ")}`
  );
  if (notes.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error("circuit:supersede failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
