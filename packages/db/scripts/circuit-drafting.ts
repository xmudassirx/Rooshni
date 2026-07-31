import { loadEnv } from "./env";
import { createServiceClient } from "../src/client";
import { emitEvent } from "../src/events";
import { submitCommunication } from "../src/approvals";
import { DRAFTING_EVENT_KINDS } from "../src/event-kinds";
import {
  composeDraft,
  createAnthropicGenerator,
  leadTextFromAnswers,
  retrieveKnowledgeEntries,
} from "../src/drafting";
import type { FormAnswer } from "../src/meta";

/**
 * DoD circuit helper (Session 15): ONE real generation through the REAL
 * drafting engine against a shadow-era enquiry with backfilled form answers
 * — insert at draft as Light, record the compliance check, submit to the
 * Approval Inbox. Nothing here approves and nothing here sends: the stamp
 * stays the founder's. The draft is a shadow-mode row like any other — the
 * daily bulk-reject covers it.
 *
 *   npm run circuit:drafting --workspace=@rooshni/db -- [--engagement <id>]
 *
 * Default target: the newest enquiry holding form_answers. Prints the draft
 * body, the credit line (tier · reason · tokens/budget · pack entry ids)
 * and the recorded compliance result.
 */

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  loadEnv();
  const db = createServiceClient();
  const generator = createAnthropicGenerator();
  if (!generator) {
    console.error("ANTHROPIC_API_KEY is not set — the circuit needs the provider.");
    process.exit(1);
  }

  // The target enquiry: named, or the newest one with backfilled answers.
  const engagementArg = arg("engagement");
  const query = db
    .from("engagements")
    .select("id, business_id, title, owner_actor_id, attributes, attribution, stage:stage_definitions(label)")
    .not("attributes->form_answers", "is", null)
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  const { data: engagements, error: engError } = engagementArg
    ? await db
        .from("engagements")
        .select("id, business_id, title, owner_actor_id, attributes, attribution, stage:stage_definitions(label)")
        .eq("id", engagementArg)
        .limit(1)
    : await query;
  if (engError) throw new Error(`engagement lookup failed: ${engError.message}`);
  const engagement = engagements?.[0];
  if (!engagement) throw new Error("No enquiry with form_answers found — run the backfill first.");

  const { data: participants } = await db
    .from("engagement_participants")
    .select("contact_id")
    .eq("engagement_id", engagement.id)
    .eq("role", "client")
    .is("archived_at", null)
    .limit(1);
  if (!participants?.[0]) throw new Error("The enquiry has no client participant.");
  const { data: contact } = await db
    .from("contacts")
    .select("id, display_name, given_name")
    .eq("id", participants[0].contact_id)
    .maybeSingle();
  if (!contact) throw new Error("Client contact not found.");

  const { data: business } = await db
    .from("businesses")
    .select("id, account_id, name, template:templates!businesses_template_id_fkey(no_go_rules)")
    .eq("id", engagement.business_id)
    .maybeSingle();
  if (!business) throw new Error("Business not found.");
  const { data: owner } = await db
    .from("actors")
    .select("display_name")
    .eq("id", engagement.owner_actor_id)
    .maybeSingle();
  const { data: agents } = await db
    .from("actors")
    .select("id, display_name")
    .eq("account_id", business.account_id)
    .eq("actor_type", "agent")
    .is("archived_at", null);
  if (agents?.length !== 1) throw new Error(`Expected exactly one agent actor, found ${agents?.length ?? 0}.`);
  const lightActor = agents[0]!;

  const embeddedTemplate = Array.isArray(business.template) ? business.template[0] : business.template;
  const noGoRules = Array.isArray(embeddedTemplate?.no_go_rules)
    ? (embeddedTemplate!.no_go_rules as unknown[]).map((r) => String(r))
    : [];

  const formAnswers = ((engagement.attributes ?? {}) as Record<string, unknown>).form_answers as FormAnswer[];
  const leadText = `${leadTextFromAnswers(formAnswers)}\n${engagement.title}`;
  const retrieval = await retrieveKnowledgeEntries(db, engagement.business_id, leadText);

  const stageRel = engagement.stage as { label: string } | { label: string }[] | null;
  const stageLabel = Array.isArray(stageRel) ? (stageRel[0]?.label ?? "") : (stageRel?.label ?? "");
  const attribution = (engagement.attribution ?? {}) as Record<string, unknown>;
  const fullName = contact.display_name ?? "";

  console.log(`Target enquiry : ${engagement.title} (${engagement.id})`);
  console.log(`Form answers   : ${formAnswers.length}`);
  for (const a of formAnswers) console.log(`  - ${a.label}: ${a.value}`);
  console.log(`Pack retrieval : ${retrieval.entries.length} entries · routes matched: ${retrieval.route_matches.join(", ") || "none"}`);

  const composed = await composeDraft(generator, {
    business_name: business.name,
    owner_name: owner?.display_name ?? "",
    first_name: contact.given_name ?? fullName.split(/\s+/)[0] ?? "",
    full_name: fullName,
    channel: "email",
    task: "intro",
    enquiry_title: engagement.title,
    stage_label: stageLabel,
    source: String(attribution.source ?? "unknown"),
    form_answers: formAnswers,
    no_go_rules: noGoRules,
    retrieval,
  });

  console.log("\n--- DRAFT ---");
  console.log(`Subject: ${composed.subject ?? "(none)"}`);
  console.log(composed.body);
  console.log("--- CREDIT LINE ---");
  console.log(
    `tier ${composed.credit_line.tier} (${composed.credit_line.model}) · ${
      composed.credit_line.reason === "floor" ? "floor — no escalation" : `escalated: ${composed.credit_line.reason}`
    } · context ${composed.credit_line.context_tokens}/${composed.credit_line.budget_tokens} tok · usage in ${composed.usage.input_tokens} / out ${composed.usage.output_tokens} · pack entry ids: ${
      composed.credit_line.knowledge_entry_ids.join(", ") || "(none — the pack is unseeded)"
    }`
  );
  console.log(`Attestation: attested=${composed.attestation.attested} — ${composed.attestation.statement}`);

  // The draft becomes a real row through the same shape the engine writes.
  const { data: threads } = await db
    .from("comm_threads")
    .select("id")
    .eq("engagement_id", engagement.id)
    .eq("channel", "email")
    .is("archived_at", null)
    .limit(1);
  let threadId = threads?.[0]?.id;
  if (!threadId) {
    const { data: created, error: threadError } = await db
      .from("comm_threads")
      .insert({
        business_id: engagement.business_id,
        created_by: lightActor.id,
        contact_id: contact.id,
        engagement_id: engagement.id,
        channel: "email",
        subject: composed.subject,
      })
      .select("id")
      .single();
    if (threadError) throw new Error(`thread insert failed: ${threadError.message}`);
    threadId = created.id;
  }

  const { data: comm, error: commError } = await db
    .from("communications")
    .insert({
      business_id: engagement.business_id,
      created_by: lightActor.id,
      thread_id: threadId,
      contact_id: contact.id,
      engagement_id: engagement.id,
      channel: "email",
      direction: "outbound",
      status: "draft",
      body: composed.body,
      body_format: "plain",
      drafted_by_actor_id: lightActor.id,
      attributes: {
        circuit: "s15-drafting",
        ...(composed.subject ? { subject: composed.subject } : {}),
        credit_line: { ...composed.credit_line, attempts: 1 },
      },
    })
    .select("id")
    .single();
  if (commError) throw new Error(`communication insert failed: ${commError.message}`);

  const { data: check, error: checkError } = await db.rpc("run_compliance_check", {
    p_comm: comm.id,
    p_actor: lightActor.id,
    p_attestation: composed.attestation,
  });
  if (checkError) throw new Error(`run_compliance_check failed: ${checkError.message}`);
  console.log("--- COMPLIANCE CHECK (recorded) ---");
  console.log(JSON.stringify(check, null, 2));

  await emitEvent(db, {
    business_id: engagement.business_id,
    actor_id: lightActor.id,
    action: "communication.drafted",
    entity_type: "communication",
    entity_id: comm.id,
    payload: { channel: "email", engagement_id: engagement.id, circuit: "s15-drafting" },
  });
  const generatedEvent = await emitEvent(db, {
    business_id: engagement.business_id,
    actor_id: lightActor.id,
    action: DRAFTING_EVENT_KINDS.draftGenerated,
    entity_type: "communication",
    entity_id: comm.id,
    payload: {
      tier: composed.credit_line.tier,
      escalation_reason: composed.credit_line.reason,
      context_tokens: composed.credit_line.context_tokens,
      budget_tokens: composed.credit_line.budget_tokens,
      knowledge_entry_ids: composed.credit_line.knowledge_entry_ids,
      compliance: (check as { result?: string })?.result ?? "unknown",
      circuit: "s15-drafting",
    },
    cost: {
      provider: "anthropic",
      model: composed.credit_line.model,
      tokens: composed.usage.input_tokens + composed.usage.output_tokens,
    },
  });
  const complianceEvent = await emitEvent(db, {
    business_id: engagement.business_id,
    actor_id: lightActor.id,
    action: DRAFTING_EVENT_KINDS.complianceChecked,
    entity_type: "communication",
    entity_id: comm.id,
    payload: {
      result: (check as { result?: string })?.result ?? "unknown",
      ...((check as { rule_matched?: string | null })?.rule_matched
        ? { rule_matched: (check as { rule_matched?: string | null }).rule_matched }
        : {}),
    },
  });

  await submitCommunication(db, {
    business_id: engagement.business_id,
    communication_id: comm.id,
    actor_id: lightActor.id,
  });

  console.log(`\nDraft ${comm.id} is PENDING in the Approval Inbox (shadow row — the daily bulk-reject covers it).`);
  console.log(`Ledger: ${generatedEvent.id} (light.draft_generated, priced) · ${complianceEvent.id} (compliance_checked).`);
}

main().catch((err) => {
  console.error("circuit:drafting failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
