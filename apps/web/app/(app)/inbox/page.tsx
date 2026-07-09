import type { ApprovalInboxRow } from "@rooshni/db";

import { PageHead } from "@/components/shell/page-head";
import { durationSince, formatWhen } from "@/lib/format";
import { getCommunicationDetail, getInbox } from "@/lib/server/queries";
import { InboxCard, type InboxCardProps } from "./inbox-card";

export const dynamic = "force-dynamic";

function channelLabel(channel: string | null): string {
  if (!channel) return "Item";
  if (channel === "whatsapp") return "WhatsApp";
  if (channel === "sms") return "SMS";
  return channel.charAt(0).toUpperCase() + channel.slice(1);
}

async function toCardProps(row: ApprovalInboxRow): Promise<InboxCardProps> {
  const isComm = row.item_type === "communication";
  const detail = isComm ? await getCommunicationDetail(row.item_id) : null;
  const scheduledNote = `Waiting since ${formatWhen(row.awaiting_since)}${
    row.scheduled_for
      ? ` · sends ${formatWhen(row.scheduled_for)} on approval`
      : " · sends when the send pipeline exists — approved ≠ sent"
  }`;

  return {
    itemType: row.item_type,
    itemId: row.item_id,
    channelLabel: channelLabel(row.channel),
    draftedBy: row.drafted_by,
    draftedByAgent: row.drafted_by_type === "agent",
    recipient: detail?.contactName ?? null,
    subject: detail?.subject ?? row.title,
    waitingFor: durationSince(row.awaiting_since),
    preview: row.preview ?? row.title ?? row.item_type,
    fullBody: detail?.body ?? null,
    scheduledNote,
    checks: row.preflight?.checks ?? [],
    preflightPass: row.preflight_pass,
  };
}

export default async function InboxPage() {
  const rows = await getInbox();
  const cards = await Promise.all(rows.map(toCardProps));

  return (
    <>
      <PageHead
        title="Approval Inbox"
        sub="Only stamps owed live here — incoming client email belongs to Conversations"
      />
      {cards.length === 0 ? (
        <div className="glass mx-auto mt-10 max-w-[560px] rounded-2xl border-dashed p-9 text-center">
          <h2 className="mb-2 font-display text-xl font-extrabold">Nothing owed</h2>
          <p className="text-sm text-ink-soft">
            No stamps are waiting. New drafts from Light land here the moment
            they are submitted.
          </p>
        </div>
      ) : (
        <div className="flex max-w-[860px] flex-col gap-3">
          {cards.map((card) => (
            <InboxCard key={`${card.itemType}-${card.itemId}`} {...card} />
          ))}
        </div>
      )}
      <p className="mt-4 font-mono text-xs text-ink-faint">
        Approving here writes communication.approved to the ledger — the inbox
        is a view over pending states, not a place things live.
      </p>
    </>
  );
}
