"use server";

import {
  getRecordEvents,
  isUuid,
  type RecordCursor,
  type RecordEntityType,
  type RecordWindow,
} from "@/lib/server/queries";

/**
 * Session 23 (WS3 — the s22 5b deferral): the infinite scroll's next window.
 * A read, not an act; RLS scopes it, each call one bounded query.
 */
export async function loadOlderRecordAction(
  filter: { entityType: RecordEntityType; entityId: string } | null,
  before: RecordCursor
): Promise<RecordWindow> {
  if (!isUuid(before.id) || (filter && !isUuid(filter.entityId))) {
    return { events: [], hasMore: false, nextCursor: null };
  }
  return getRecordEvents(filter ?? undefined, before);
}
