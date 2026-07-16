import { PageHead } from "@/components/shell/page-head";
import { getConversations } from "@/lib/server/queries";

import { ConversationsClient } from "./conversations-client";

export const dynamic = "force-dynamic";

export default async function ConversationsPage() {
  const threads = await getConversations();

  return (
    <>
      <PageHead
        title="Conversations"
        sub="One inbox across WhatsApp, email and SMS — every message is a row on The Record"
      />
      <ConversationsClient threads={threads} />
    </>
  );
}
