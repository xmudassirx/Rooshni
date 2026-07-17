import { loadEnv } from "./env";
import { createServiceClient } from "../src/client";
import { emitEvent } from "../src/events";
import { submitCommunication } from "../src/approvals";

/**
 * DoD circuit helper (Session 10, proof ①): draft ONE WhatsApp template
 * message through the REAL pipeline — insert at draft as Light, submit to
 * the Approval Inbox — so the founder can stamp it and watch the template
 * land on a real handset. Nothing here sends and nothing here approves: the
 * stamp stays the founder's, and dispatch runs only after it.
 *
 *   npm run circuit:wa-draft --workspace=@rooshni/db -- \
 *     --to +447496166555 --template hello_world --language en_US [--contact <id>]
 *
 * The target contact defaults to the newest contact holding the given phone;
 * a consented WhatsApp channel is added for it if missing — the number is
 * the founder's own handset, consenting to his own circuit message.
 */

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  loadEnv();
  const phone = arg("to");
  const templateName = arg("template") ?? "hello_world";
  const language = arg("language") ?? "en_US";
  const contactArg = arg("contact");
  if (!phone) {
    console.error("Usage: npm run circuit:wa-draft -- --to <E.164 phone> [--template hello_world] [--language en_US] [--contact <id>]");
    process.exit(1);
  }

  const db = createServiceClient();

  // The contact: named, or the newest one carrying this phone.
  let contact: { id: string; business_id: string; display_name: string } | null = null;
  if (contactArg) {
    const { data } = await db.from("contacts").select("id, business_id, display_name").eq("id", contactArg).maybeSingle();
    contact = data;
  } else {
    const { data: channels } = await db
      .from("contact_channels")
      .select("contact_id")
      .eq("channel", "phone")
      .eq("value", phone)
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(1);
    if (channels?.[0]) {
      const { data } = await db
        .from("contacts")
        .select("id, business_id, display_name")
        .eq("id", channels[0].contact_id)
        .maybeSingle();
      contact = data;
    }
  }
  if (!contact) {
    console.error(`No contact found for ${phone} — pass --contact <id> (the circuit lead's contact).`);
    process.exit(1);
  }

  // Actors: Light drafts (agent), per the account of this business.
  const { data: business } = await db
    .from("businesses")
    .select("id, account_id, name")
    .eq("id", contact.business_id)
    .maybeSingle();
  if (!business) throw new Error("business not found");
  const { data: agents } = await db
    .from("actors")
    .select("id")
    .eq("account_id", business.account_id)
    .eq("actor_type", "agent")
    .is("archived_at", null);
  if (!agents || agents.length !== 1) throw new Error(`expected exactly one agent actor, saw ${agents?.length ?? 0}`);
  const light = agents[0]!.id;

  // A consented WhatsApp channel for the founder's own handset (his consent,
  // his circuit). Idempotent.
  const { data: waChannels } = await db
    .from("contact_channels")
    .select("id")
    .eq("contact_id", contact.id)
    .eq("channel", "whatsapp")
    .is("archived_at", null);
  if (!waChannels?.length) {
    const { error } = await db.from("contact_channels").insert({
      business_id: contact.business_id,
      created_by: light,
      contact_id: contact.id,
      channel: "whatsapp",
      value: phone,
      is_primary: true,
      consent: {
        marketing: false,
        transactional: true,
        granted_at: new Date().toISOString(),
        source: "founder_circuit",
      },
    });
    if (error) throw new Error(`whatsapp channel insert failed: ${error.message}`);
    console.log(`Consented WhatsApp channel added for ${contact.display_name} (${phone}).`);
  }

  // The engagement + thread (whatsapp) for this contact, if one exists.
  const { data: participants } = await db
    .from("engagement_participants")
    .select("engagement_id")
    .eq("contact_id", contact.id)
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  const engagementId = participants?.[0]?.engagement_id ?? null;

  const { data: threads } = await db
    .from("comm_threads")
    .select("id")
    .eq("contact_id", contact.id)
    .eq("channel", "whatsapp")
    .is("archived_at", null)
    .limit(1);
  let threadId = threads?.[0]?.id;
  if (!threadId) {
    const { data: created, error } = await db
      .from("comm_threads")
      .insert({
        business_id: contact.business_id,
        created_by: light,
        contact_id: contact.id,
        engagement_id: engagementId,
        channel: "whatsapp",
        subject: null,
      })
      .select("id")
      .single();
    if (error) throw new Error(`thread insert failed: ${error.message}`);
    threadId = created.id;
  }

  const body =
    `[WhatsApp template: ${templateName}/${language}] ` +
    `Circuit proof draft — on approval this dispatches the Meta-approved "${templateName}" template to ${phone}.`;

  const { data: comm, error: commError } = await db
    .from("communications")
    .insert({
      business_id: contact.business_id,
      created_by: light,
      thread_id: threadId,
      contact_id: contact.id,
      engagement_id: engagementId,
      channel: "whatsapp",
      direction: "outbound",
      status: "draft",
      body,
      body_format: "plain",
      drafted_by_actor_id: light,
      attributes: { wa_template: { name: templateName, language }, circuit: "session-10-dod" },
    })
    .select("id")
    .single();
  if (commError) throw new Error(`draft insert failed: ${commError.message}`);

  await emitEvent(db, {
    business_id: contact.business_id,
    actor_id: light,
    action: "communication.drafted",
    entity_type: "communication",
    entity_id: comm.id,
    payload: { channel: "whatsapp", wa_template: templateName, circuit: "session-10-dod" },
  });
  await submitCommunication(db, {
    business_id: contact.business_id,
    communication_id: comm.id,
    actor_id: light,
  });

  console.log(
    `WhatsApp template draft ${comm.id} awaits the stamp in the Approval Inbox (${business.name}). ` +
      `Approve it there — dispatch follows the stamp.`
  );
}

main().catch((err) => {
  console.error("circuit:wa-draft failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
