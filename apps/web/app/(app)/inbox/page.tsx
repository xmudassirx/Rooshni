import Link from "next/link";
import { CheckCircle2, CircleDashed, Sparkles, XCircle } from "lucide-react";
import type { ApprovalInboxRow, PreflightCheck } from "@rooshni/db";

import { PageHead } from "@/components/shell/page-head";
import { Badge } from "@/components/ui/badge";
import { durationSince, formatWhen } from "@/lib/format";
import { getCommunicationDetail, getInbox } from "@/lib/server/queries";
import { cn } from "@/lib/utils";
import { DecisionControls } from "./decision-controls";

export const dynamic = "force-dynamic";

/**
 * Checks the database has not run yet (link resolution and standards/no-go
 * compliance arrive with the app layer — decision 19). They display as
 * pending, never as a green tick: an unearned tick is a lie about safety.
 */
const NOT_YET_RUN: Array<{ key: string; label: string }> = [
  { key: "links", label: "Links resolve" },
  { key: "compliance", label: "Standards & no-go compliance" },
];

function channelLabel(channel: string | null): string {
  if (!channel) return "Item";
  if (channel === "whatsapp") return "WhatsApp";
  if (channel === "sms") return "SMS";
  return channel.charAt(0).toUpperCase() + channel.slice(1);
}

function PreflightList({ checks }: { checks: PreflightCheck[] | null }) {
  const ran = checks ?? [];
  const pending = [
    ...(checks === null
      ? [
          { key: "body", label: "Message body present" },
          { key: "placeholders", label: "No unresolved template variables" },
          { key: "consent", label: "Channel consent held" },
          { key: "attachment", label: "Referenced attachments present" },
        ]
      : []),
    ...NOT_YET_RUN,
  ];

  return (
    <ul className="flex flex-col gap-1.5">
      {ran.map((check) => (
        <li key={check.key} className="flex items-start gap-2 text-[13px]">
          {check.pass ? (
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-ledger" />
          ) : (
            <XCircle className="mt-0.5 size-3.5 shrink-0 text-stamp" />
          )}
          <span>
            {check.label}
            {check.detail ? (
              <span className="block text-[11.5px] text-stamp">{check.detail}</span>
            ) : null}
          </span>
        </li>
      ))}
      {pending.map((check) => (
        <li
          key={check.key}
          className="flex items-start gap-2 text-[13px] text-ink-faint"
        >
          <CircleDashed className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {check.label}
            <span className="block text-[11.5px]">
              Pending — not yet checked, so not yet ticked
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function DraftedBy({ row }: { row: ApprovalInboxRow }) {
  const name = row.drafted_by ?? "Unknown";
  if (row.drafted_by_type === "agent") {
    return (
      <Badge variant="gold">
        <Sparkles className="size-3" /> drafted by {name}
      </Badge>
    );
  }
  return <Badge variant="time">drafted by {name}</Badge>;
}

async function DetailPanel({ row }: { row: ApprovalInboxRow }) {
  const isComm = row.item_type === "communication";
  const detail = isComm ? await getCommunicationDetail(row.item_id) : null;
  const blockedDetails = (row.preflight?.checks ?? [])
    .filter((c) => !c.pass && c.detail)
    .map((c) => c.detail as string);

  return (
    <div className="glass overflow-hidden rounded-xl">
      <div className="border-b border-rule bg-paper px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="source">{channelLabel(row.channel)}</Badge>
          <DraftedBy row={row} />
          <Badge variant="red">awaiting your stamp</Badge>
          <span className="ml-auto font-mono text-[10px] text-ink-faint">
            waiting {durationSince(row.awaiting_since)}
          </span>
        </div>
        {detail?.contactName || row.title ? (
          <div className="mt-2 text-sm font-bold">
            {detail?.contactName ? `To ${detail.contactName}` : null}
            {detail?.subject ? (
              <span className="font-normal text-ink-soft"> · {detail.subject}</span>
            ) : null}
            {!detail?.contactName && !detail?.subject ? row.title : null}
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-4 p-4">
        <div className="rounded-lg border border-rule bg-paper px-3.5 py-3 text-[13.5px] whitespace-pre-wrap">
          {detail?.body ?? row.preview ?? "No preview available."}
        </div>

        <div className="font-mono text-[10px] tracking-wide text-ink-faint uppercase">
          Waiting since {formatWhen(row.awaiting_since)}
          {row.scheduled_for
            ? ` · sends ${formatWhen(row.scheduled_for)} on approval`
            : " · sends when the send pipeline exists — approved ≠ sent"}
        </div>

        <div>
          <h3 className="mb-2 font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-soft uppercase">
            Readiness pre-flight
          </h3>
          <PreflightList checks={row.preflight?.checks ?? null} />
        </div>

        {isComm ? (
          <DecisionControls
            communicationId={row.item_id}
            preflightPass={row.preflight_pass === true}
            blockedDetails={blockedDetails}
          />
        ) : (
          <p className="text-[12.5px] text-ink-soft">
            The approve/reject pipeline for {row.item_type} items arrives in a
            later session — this row is read-only until then.
          </p>
        )}
      </div>
    </div>
  );
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ item?: string }>;
}) {
  const [{ item }, rows] = await Promise.all([searchParams, getInbox()]);
  const selected = rows.find((r) => r.item_id === item) ?? rows[0] ?? null;

  return (
    <>
      <PageHead
        title="Approval Inbox"
        sub="Only stamps owed live here — incoming client email belongs to Conversations"
      />
      {rows.length === 0 ? (
        <div className="glass mx-auto mt-10 max-w-[560px] rounded-2xl border-dashed p-9 text-center">
          <h2 className="mb-2 font-display text-xl font-extrabold">Nothing owed</h2>
          <p className="text-sm text-ink-soft">
            No stamps are waiting. New drafts from Light land here the moment
            they are submitted.
          </p>
        </div>
      ) : (
        <div className="grid items-start gap-4 min-[880px]:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <div className="flex flex-col gap-2.5">
            {rows.map((row) => {
              const isSelected = selected?.item_id === row.item_id;
              return (
                <Link
                  key={`${row.item_type}-${row.item_id}`}
                  href={`/inbox?item=${row.item_id}`}
                  className={cn(
                    "glass block rounded-xl p-3.5 transition-colors",
                    isSelected ? "border-ledger" : "hover:border-ledger/50"
                  )}
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="source">{channelLabel(row.channel)}</Badge>
                    <DraftedBy row={row} />
                    <span className="ml-auto font-mono text-[10px] text-ink-faint">
                      waiting {durationSince(row.awaiting_since)}
                    </span>
                  </div>
                  <div className="mt-2 line-clamp-2 text-[13px] text-ink-soft">
                    {row.preview ?? row.title ?? row.item_type}
                  </div>
                </Link>
              );
            })}
          </div>
          {selected ? <DetailPanel row={selected} /> : null}
        </div>
      )}
      <p className="mt-4 font-mono text-xs text-ink-faint">
        Approving here writes communication.approved to the ledger — the inbox
        is a view over pending states, not a place things live.
      </p>
    </>
  );
}
