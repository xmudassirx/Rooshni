import Link from "next/link";

import { PageHead } from "@/components/shell/page-head";
import {
  getRecordEvents,
  isUuid,
  type RecordEntityType,
} from "@/lib/server/queries";

import { RecordList } from "./record-list";

export const dynamic = "force-dynamic";

/**
 * The Record — the events ledger rendered for humans. Read-only by nature and
 * by law: the table refuses UPDATE and DELETE structurally, so this screen
 * could not edit history even if it tried.
 *
 * Accepts an optional deep-link filter (?entity_type=engagement&entity_id=…)
 * so the detail pages can point at one thread of the story.
 */
export default async function RecordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const entityType =
    params.entity_type === "engagement" || params.entity_type === "contact"
      ? (params.entity_type as RecordEntityType)
      : null;
  const entityId =
    typeof params.entity_id === "string" && isUuid(params.entity_id) ? params.entity_id : null;
  const filter = entityType && entityId ? { entityType, entityId } : undefined;

  const events = await getRecordEvents(filter);

  return (
    <>
      <PageHead
        title="The Record"
        sub="Append-only, forever — every actor writes here, no one edits, not even you"
      />

      {filter ? (
        <div className="glass mb-4 flex flex-wrap items-center gap-2.5 rounded-xl px-3.5 py-2.5">
          <span className="font-mono text-[11px] font-semibold tracking-wide text-ink-soft uppercase">
            Filtered to one {filter.entityType === "engagement" ? "enquiry" : "contact"} — its
            whole story, oldest to newest below
          </span>
          <Link
            href="/record"
            className="ml-auto font-mono text-[11px] font-semibold tracking-wide text-ledger uppercase hover:underline"
          >
            Clear filter →
          </Link>
        </div>
      ) : null}

      <RecordList events={events} />

      <p className="mt-3 font-mono text-xs text-ink-faint">
        RENDERED AS PLAIN ENGLISH FOR HUMANS; STORED AS STRUCTURE FOR MACHINES. HARD DELETES DO
        NOT EXIST — HISTORY IS THE PRODUCT&apos;S SPINE.
      </p>
    </>
  );
}
