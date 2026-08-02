import { PageHead } from "@/components/shell/page-head";
import { getConversations, getThreadDraftStamps } from "@/lib/server/queries";

import { ConversationsClient } from "./conversations-client";

export const dynamic = "force-dynamic";

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<{ thread?: string }>;
}) {
  // Session 11: the inbox History tab deep-links a decided draft's thread.
  const [{ thread }, threads] = await Promise.all([searchParams, getConversations()]);

  // Session 23 (WS1b): the thread view of the same stamp — pre-flight state
  // and the render-resolved WYSIWYS body for every pending draft in view.
  // Small by construction (0029: at most one pending per engagement per
  // channel), bounded in the query.
  const pendingIds = threads.flatMap((t) =>
    t.messages.filter((m) => m.isPendingDraft).map((m) => m.id)
  );
  const draftStamps = await getThreadDraftStamps(pendingIds);

  return (
    <>
      <PageHead
        title="Conversations"
        sub="One inbox across WhatsApp, email and SMS — every message is a row on The Record"
      />
      <ConversationsClient
        threads={threads}
        initialThreadId={thread ?? null}
        draftStamps={draftStamps}
      />
    </>
  );
}
