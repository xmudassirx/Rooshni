import {
  listMemoryEntries,
  memoryInstructionTokens,
  MEMORY_INSTRUCTION_TOKEN_CEILING,
  type MemoryEntryRow,
} from "@rooshni/db";

import { PageHead } from "@/components/shell/page-head";
import { getAppContext } from "@/lib/server/context";

import { MemoryClient, type MemoryEntryView, type SurfaceOption } from "./memory-client";

export const dynamic = "force-dynamic";

/*
 * Session 32 — Light's Memory goes real (D181). Two sections: FACTS
 * (business facts with their declared surfaces lists — editing one fires
 * the ripple sweep) and BEHAVIOUR (standing instructions bounded by the
 * 800-token ceiling, and observations from rejection reasons with their
 * one-click human PROMOTE). History is the append-only supersede chain,
 * rendered, never rewritten.
 *
 * JUDGMENT (approved at pre-flight): the master mockup's view-memory screen
 * reflects the dead Spec 2 card model; D181 supersedes it for this screen's
 * STRUCTURE — the mockup remains authority for the design language.
 */

function toView(
  entry: MemoryEntryRow,
  actorNames: Map<string, string>,
  history: MemoryEntryRow[]
): MemoryEntryView {
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    body: entry.body,
    active: entry.active,
    why: entry.why,
    surfaces: entry.surfaces,
    createdBy: actorNames.get(entry.created_by) ?? "unknown",
    createdAt: entry.created_at,
    law: typeof entry.attributes.law === "string" ? entry.attributes.law : null,
    factKey: typeof entry.attributes.fact_key === "string" ? entry.attributes.fact_key : null,
    fromRejection: entry.attributes.source === "draft_rejection",
    promotedFrom: typeof entry.attributes.promoted_from === "string" ? entry.attributes.promoted_from : null,
    history: history.map((h) => ({
      id: h.id,
      body: h.body,
      why: h.why,
      createdBy: actorNames.get(h.created_by) ?? "unknown",
      createdAt: h.created_at,
    })),
  };
}

export default async function MemoryPage() {
  const { db, business } = await getAppContext();
  const entries = await listMemoryEntries(db, business.id);

  const actorIds = [...new Set(entries.map((e) => e.created_by))];
  const actorNames = new Map<string, string>();
  if (actorIds.length) {
    const { data: actors } = await db.from("actors").select("id, display_name").in("id", actorIds);
    for (const a of actors ?? []) actorNames.set(a.id, a.display_name);
  }

  // The supersede chain, walked backwards: predecessor → successor via
  // superseded_by_entry_id. An entry's history is its predecessors, newest
  // first.
  const bySuccessor = new Map<string, MemoryEntryRow>();
  for (const e of entries) {
    if (e.superseded_by_entry_id) bySuccessor.set(e.superseded_by_entry_id, e);
  }
  const chainFor = (entry: MemoryEntryRow): MemoryEntryRow[] => {
    const chain: MemoryEntryRow[] = [];
    let cursor = bySuccessor.get(entry.id);
    while (cursor && chain.length < 50) {
      chain.push(cursor);
      cursor = bySuccessor.get(cursor.id);
    }
    return chain;
  };

  const active = (kind: string) => entries.filter((e) => e.kind === kind && e.active);
  // Retired = deactivated with no successor (a superseded entry renders in
  // its living head's history instead).
  const retired = (kind: string) =>
    entries.filter((e) => e.kind === kind && !e.active && !e.superseded_by_entry_id);

  const facts = active("fact").map((e) => toView(e, actorNames, chainFor(e)));
  const instructions = active("instruction").map((e) => toView(e, actorNames, chainFor(e)));
  const observations = active("observation").map((e) => toView(e, actorNames, chainFor(e)));
  const retiredEntries = ["fact", "instruction", "observation"]
    .flatMap((k) => retired(k))
    .map((e) => toView(e, actorNames, chainFor(e)));

  const tokenCount = memoryInstructionTokens(instructions.map((i) => i.body));

  // The surface editor's honest options: real templates and real published
  // knowledge entries — never a free-typed in-platform ref.
  const [{ data: templates }, { data: knowledgeEntries }] = await Promise.all([
    db.from("message_templates").select("key").eq("business_id", business.id),
    db
      .from("content_items")
      .select("id, title")
      .eq("business_id", business.id)
      .eq("content_type", "knowledge_entry")
      .eq("state", "published")
      .is("archived_at", null),
  ]);
  const surfaceOptions: SurfaceOption[] = [
    ...[...new Set((templates ?? []).map((t) => t.key as string))].map((key) => ({
      surface: "message_template",
      label: `Template: ${key}`,
      ref: key,
      in_platform: true,
    })),
    ...(knowledgeEntries ?? []).map((k) => ({
      surface: "knowledge_entry",
      label: k.title as string,
      ref: k.id as string,
      in_platform: true,
    })),
  ];

  return (
    <>
      <PageHead
        title="Light's Memory"
        sub="Everything Light believes — nothing hidden, everything editable, every edit on The Record"
      />
      <MemoryClient
        facts={facts}
        instructions={instructions}
        observations={observations}
        retired={retiredEntries}
        tokenCount={tokenCount}
        tokenCeiling={MEMORY_INSTRUCTION_TOKEN_CEILING}
        surfaceOptions={surfaceOptions}
      />
    </>
  );
}
