import Link from "next/link";
import type { ApprovalInboxRow } from "@rooshni/db";

import { PageHead } from "@/components/shell/page-head";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { durationSince, formatWhen } from "@/lib/format";
import {
  getCommunicationDetail,
  getInbox,
  getInboxHistory,
  type InboxHistoryRow,
} from "@/lib/server/queries";
import { cn } from "@/lib/utils";
import { type InboxCardProps } from "./inbox-card";
import { OwedList } from "./owed-list";

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
      : " · dispatches on approval — quiet hours hold it"
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
    context: detail?.context ?? null,
    // Session 15 (PR-3): Light's spend and sources, on the card at stamp time.
    creditLine: detail?.creditLine ?? null,
    // Session 15 fix round: an edited pending body wears its state — a fact
    // in neutral chrome, never gold, never red, never green.
    editedNote: detail?.editedBy
      ? `edited by ${detail.editedBy.name} · ${formatWhen(detail.editedBy.at)}`
      : null,
    // Session 16 (decision 133a): the card names what it replaced.
    supersedeNote: detail?.supersedes
      ? `supersedes an earlier draft · ${detail.supersedes.newMessagesSince} new ${
          detail.supersedes.newMessagesSince === 1 ? "message" : "messages"
        } since`
      : null,
    // Session 16 (PR-F): approver mode — the body above is already the
    // render-resolved form for this viewer (WYSIWYS); the note states it.
    signOffNote: detail?.signOff
      ? detail.signOff.resolvedTo
        ? `sign-off resolves to you at the stamp — shown as it will send: ${detail.signOff.resolvedTo}`
        : "sign-off resolves to the stamping approver at the stamp"
      : null,
    // PR-iii (Session 19): the stamp view can show the rendered mail — the
    // same deterministic renderer dispatch uses, over the same words.
    emailHtmlPreview: detail?.emailHtmlPreview ?? null,
    // PR-i (Session 19): the declared attachment(s), named on the card.
    attachmentNotes: (detail?.attachments ?? []).map(
      (a) => `⎘ ${a.filename} · ${(a.sizeBytes / 1024 / 1024).toFixed(1)}MB`
    ),
  };
}

function HistoryRow({ row }: { row: InboxHistoryRow }) {
  return (
    <div className="glass flex flex-wrap items-start gap-2.5 rounded-xl px-4 py-3">
      <span
        className={cn(
          "mt-0.5 rounded-md border px-2 py-0.5 font-mono text-[9.5px] font-semibold tracking-wide uppercase",
          row.action === "approved"
            ? "border-ledger/40 bg-ledger/10 text-ledger"
            : row.action === "superseded"
              ? // Session 16: superseded is a FACT in neutral chrome — not a
                // stamp act (red), not done (green), not Light's channel.
                "border-rule bg-paper-deep text-ink-soft"
              : "border-stamp/40 bg-stamp/10 text-stamp"
        )}
      >
        {row.action === "approved"
          ? "✓ Approved"
          : row.action === "superseded"
            ? "⇢ Superseded"
            : "✗ Rejected"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
          <Badge variant="source">{channelLabel(row.channel)}</Badge>
          {row.contactName ? <span className="font-semibold">→ {row.contactName}</span> : null}
          <span className="ml-auto font-mono text-[10px] text-ink-faint">
            {formatWhen(row.occurredAt)}
            {row.actorName ? ` · by ${row.actorName}` : ""}
          </span>
        </div>
        {row.preview ? (
          <p className="mt-1 line-clamp-1 text-[12.5px] text-ink-soft">{row.preview}</p>
        ) : null}
        {row.reason ? (
          row.action === "superseded" ? (
            <p className="mt-1 font-mono text-[10.5px] tracking-wide text-ink-soft">
              {row.reason === "human_replied"
                ? "a human replied on the thread — the draft was retired"
                : row.reason === "new_inbound"
                  ? "a new client message arrived — regenerated against the full thread"
                  : row.reason}
            </p>
          ) : (
            <p className="mt-1 text-[12px] text-stamp">&ldquo;{row.reason}&rdquo;</p>
          )
        ) : null}
        <div className="mt-1.5 flex gap-3 font-mono text-[10px] tracking-wide uppercase">
          {row.threadId ? (
            <Link href={`/conversations?thread=${row.threadId}`} className="text-accent hover:underline">
              Open thread →
            </Link>
          ) : null}
          <Link
            href={
              row.engagementId
                ? `/record?entity_type=engagement&entity_id=${row.engagementId}`
                : "/record"
            }
            className="text-accent hover:underline"
          >
            On The Record →
          </Link>
        </div>
      </div>
    </div>
  );
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; days?: string }>;
}) {
  const params = await searchParams;
  const days: 7 | 30 = params.days === "30" ? 30 : 7;
  const activeTab = params.tab === "history" ? "history" : "owed";

  const [rows, history] = await Promise.all([getInbox(), getInboxHistory(days)]);
  const cards = await Promise.all(rows.map(toCardProps));

  return (
    <>
      <PageHead
        title="Approval Inbox"
        sub="Only stamps owed live here — incoming client email belongs to Conversations"
      />
      <Tabs defaultValue={activeTab}>
        <TabsList>
          <TabsTrigger value="owed">
            Stamps owed{cards.length ? ` · ${cards.length}` : ""}
          </TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="owed">
          {cards.length === 0 ? (
            <div className="glass mx-auto mt-6 max-w-[560px] rounded-2xl border-dashed p-9 text-center">
              <h2 className="mb-2 font-display text-xl font-extrabold">Nothing owed</h2>
              <p className="text-sm text-ink-soft">
                No stamps are waiting. New drafts from Light land here the moment
                they are submitted.
              </p>
            </div>
          ) : (
            // Session 12: selection mode + bulk Reject live in the client
            // list. Approve keeps no bulk path — see docs/DECISIONS.md.
            <OwedList cards={cards} />
          )}
        </TabsContent>

        <TabsContent value="history">
          <div className="mb-3 flex items-center gap-2 font-mono text-[10.5px] tracking-wide text-ink-faint uppercase">
            Decisions from The Record ·
            <Link
              href="/inbox?tab=history&days=7"
              className={cn("hover:underline", days === 7 ? "font-bold text-accent" : "")}
            >
              last 7 days
            </Link>
            ·
            <Link
              href="/inbox?tab=history&days=30"
              className={cn("hover:underline", days === 30 ? "font-bold text-accent" : "")}
            >
              last 30 days
            </Link>
          </div>
          {history.length === 0 ? (
            <div className="glass mx-auto mt-6 max-w-[560px] rounded-2xl border-dashed p-9 text-center">
              <h2 className="mb-2 font-display text-xl font-extrabold">
                No decisions in the last {days} days
              </h2>
              <p className="text-sm text-ink-soft">
                Approved and rejected drafts appear here, read straight from The
                Record — nothing is ever deleted, only decided.
              </p>
            </div>
          ) : (
            <div className="flex max-w-[860px] flex-col gap-2.5">
              {history.map((row) => (
                <HistoryRow key={row.eventId} row={row} />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
      <p className="mt-4 font-mono text-xs text-ink-faint">
        Approving here writes communication.approved to the ledger — the inbox
        is a view over pending states, not a place things live.
      </p>
    </>
  );
}
