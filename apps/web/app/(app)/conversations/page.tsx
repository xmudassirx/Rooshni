import { PageHead } from "@/components/shell/page-head";
import {
  getConversationList,
  getOpenThread,
  getThreadDraftStamps,
  getViewerStampAuthority,
  isUuid,
} from "@/lib/server/queries";

import { ConversationsClient } from "./conversations-client";

export const dynamic = "force-dynamic";

/*
 * Session 23 (WS2, founder directive) — the Messenger shape, server-fed by
 * windows (the s22 5c deferral): the thread list reads one page; the open
 * thread reads its recent tail; older messages arrive on upward scroll.
 */
export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<{ thread?: string; lpage?: string }>;
}) {
  const params = await searchParams;
  const listPage = Number(params.lpage ?? "1");
  const requestedThread = params.thread && isUuid(params.thread) ? params.thread : null;

  const [list, explicitThread] = await Promise.all([
    getConversationList(Number.isFinite(listPage) ? listPage : 1),
    requestedThread ? getOpenThread(requestedThread) : Promise.resolve(null),
  ]);

  // Desktop auto-opens the newest conversation (Messenger's own behaviour);
  // the client keeps the LIST full-screen on a phone unless a thread was
  // explicitly opened, and only an explicit open marks the thread read there.
  const thread =
    explicitThread ?? (list.rows[0] ? await getOpenThread(list.rows[0].id) : null);

  // WS1b: the thread view of the same stamp, for pending drafts in the tail.
  const pendingIds = (thread?.messages ?? [])
    .filter((m) => m.isPendingDraft)
    .map((m) => m.id);
  const [draftStamps, viewerCanStamp] = await Promise.all([
    getThreadDraftStamps(pendingIds),
    getViewerStampAuthority(),
  ]);

  return (
    <>
      <PageHead
        title="Conversations"
        sub="One inbox across WhatsApp, email and SMS — every message is a row on The Record"
      />
      <ConversationsClient
        list={list}
        thread={thread}
        explicitThread={Boolean(explicitThread)}
        draftStamps={draftStamps}
        viewerCanStamp={viewerCanStamp}
      />
    </>
  );
}
