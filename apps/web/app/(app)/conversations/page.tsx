import { PageHead } from "@/components/shell/page-head";
import { getConversations } from "@/lib/server/queries";

import { ConversationsClient } from "./conversations-client";

export const dynamic = "force-dynamic";

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<{ thread?: string }>;
}) {
  // Session 11: the inbox History tab deep-links a decided draft's thread.
  const [{ thread }, threads] = await Promise.all([searchParams, getConversations()]);

  return (
    <>
      <PageHead
        title="Conversations"
        sub="One inbox across WhatsApp, email and SMS — every message is a row on The Record"
      />
      <ConversationsClient threads={threads} initialThreadId={thread ?? null} />
    </>
  );
}
