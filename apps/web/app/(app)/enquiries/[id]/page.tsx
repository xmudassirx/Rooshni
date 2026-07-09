import Link from "next/link";
import { notFound } from "next/navigation";
import { Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { formatGBP, formatWhen } from "@/lib/format";
import { describeEvent } from "@/lib/record-language";
import {
  getEnquiryDetail,
  type ChannelConsent,
  type EnquiryComm,
  type EnquiryDetail,
  type EnquiryStageMove,
  type RecordEvent,
} from "@/lib/server/queries";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

/*
 * Enquiry detail — one lead's whole story on one screen, read-only. The
 * timeline merges three sources over the same database every other face
 * reads: the events ledger, stage_history, and communications. Approving
 * lives in the Approval Inbox; pending drafts here link across to it.
 */

type TimelineItem =
  | { kind: "event"; at: string; event: RecordEvent }
  | { kind: "stage"; at: string; move: EnquiryStageMove; label: string }
  | { kind: "comm"; at: string; comm: EnquiryComm };

function buildTimeline(detail: EnquiryDetail): TimelineItem[] {
  const stageLabels = new Map(detail.stages.map((s) => [s.id, s.label]));
  const items: TimelineItem[] = [];

  for (const event of detail.events) {
    // The communication cards below tell the comms story with the full draft;
    // repeating their ledger entries here would say everything twice.
    if (event.action.startsWith("communication.")) continue;
    items.push({ kind: "event", at: event.occurredAt, event });
  }
  for (const move of detail.stageHistory) {
    // The opening move (from nowhere) is already told by engagement.created.
    if (!move.fromStageId) continue;
    items.push({
      kind: "stage",
      at: move.movedAt,
      move,
      label: stageLabels.get(move.toStageId) ?? "another stage",
    });
  }
  for (const comm of detail.comms) {
    if (comm.channel === "internal_note") continue;
    items.push({ kind: "comm", at: comm.occurredAt, comm });
  }

  return items.sort((a, b) => a.at.localeCompare(b.at));
}

function Pin({ tone }: { tone: "neutral" | "gold" | "red" | "green" }) {
  return (
    <span
      className={cn(
        "absolute top-3.5 left-[5px] z-1 size-4.5 rounded-full border-2",
        tone === "gold" && "border-gold bg-gold-tint",
        tone === "red" && "border-stamp bg-stamp-tint",
        tone === "green" && "border-ledger bg-ledger-tint",
        tone === "neutral" && "border-ink-faint bg-paper"
      )}
    />
  );
}

function When({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[10.5px] tracking-wide text-ink-faint uppercase">{children}</div>
  );
}

function channelLabel(channel: string): string {
  if (channel === "whatsapp") return "WhatsApp";
  if (channel === "sms") return "SMS";
  return channel.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function CommCard({ comm, clientName }: { comm: EnquiryComm; clientName: string | null }) {
  const byLight = comm.draftedByType === "agent";
  const inbound = comm.direction === "inbound";
  const pending = comm.status === "pending_approval";
  const tone = pending || byLight ? "gold" : "neutral";

  return (
    <div className="relative py-3 pl-10.5">
      <Pin tone={tone} />
      <When>
        {formatWhen(comm.occurredAt)} ·{" "}
        {inbound ? "Inbound" : (comm.draftedByName ?? "Outbound")}
        {pending ? " · awaiting your stamp" : ""}
      </When>
      <div className="mt-0.5 text-[13.5px]">
        {inbound ? (
          <>
            <b>{clientName ?? "The client"} replied</b>
            {comm.subject ? <> — {comm.subject}</> : null}
          </>
        ) : (
          <b>{comm.subject ?? `${channelLabel(comm.channel)} message`}</b>
        )}
      </div>
      <div className="glass mt-2 rounded-lg p-3 text-[13px]">
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
          <Badge variant="source">{channelLabel(comm.channel)}</Badge>
          {byLight ? <Badge variant="gold">✦ drafted by Light</Badge> : null}
          {pending ? <Badge variant="red">pending your stamp</Badge> : null}
          {comm.status === "approved" && comm.approvedByName ? (
            <Badge variant="red">stamped by {comm.approvedByName}</Badge>
          ) : null}
          {comm.status === "approved" && comm.approvedAt ? (
            <Badge variant="green">approved {formatWhen(comm.approvedAt)}</Badge>
          ) : null}
          {["sent", "delivered", "read"].includes(comm.status) ? (
            <Badge variant="green">{comm.status}</Badge>
          ) : null}
          {comm.status === "draft" && comm.rejection ? (
            <Badge variant="gold">returned to Light&apos;s queue</Badge>
          ) : null}
          {comm.scheduledFor ? (
            <Badge variant="time">scheduled {formatWhen(comm.scheduledFor)}</Badge>
          ) : null}
        </div>
        <div className="whitespace-pre-wrap text-ink">{comm.body}</div>
        {comm.rejection ? (
          <div className="mt-2 border-t border-dashed border-rule pt-2 text-[12px] text-stamp">
            Rejected by {comm.rejection.byName}, {formatWhen(comm.rejection.at)} — “
            {comm.rejection.reason}”
          </div>
        ) : null}
        {pending ? (
          <div className="mt-2.5 border-t border-dashed border-rule pt-2">
            <Link
              href="/inbox"
              className="font-mono text-[11px] font-semibold tracking-wide text-stamp uppercase hover:underline"
            >
              Review in the Approval Inbox →
            </Link>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TimelineEntry({ item, clientName }: { item: TimelineItem; clientName: string | null }) {
  if (item.kind === "comm") {
    return <CommCard comm={item.comm} clientName={clientName} />;
  }
  if (item.kind === "stage") {
    return (
      <div className="relative py-3 pl-10.5">
        <Pin tone="green" />
        <When>
          {formatWhen(item.move.movedAt)} · {item.move.movedByName}
        </When>
        <div className="mt-0.5 text-[13.5px]">
          <b>Stage moved</b> → {item.label}
        </div>
      </div>
    );
  }
  const byLight = item.event.actorType === "agent";
  return (
    <div className="relative py-3 pl-10.5">
      <Pin tone={byLight ? "gold" : "neutral"} />
      <When>
        {formatWhen(item.event.occurredAt)} · {item.event.actorName}
      </When>
      <div className="mt-0.5 text-[13.5px]">
        <span className="font-mono text-[10px] tracking-wide text-ledger">{item.event.action}</span>{" "}
        — {describeEvent(item.event.action, item.event.payload)}
      </div>
    </div>
  );
}

function consentSummary(channels: ChannelConsent[]): {
  line: string;
  sub: string | null;
} | null {
  if (channels.length === 0) return null;
  const parts = channels.map((c) => {
    const consented = ["marketing", "transactional"].filter((k) => c.consent[k] === true);
    return consented.length
      ? `✓ ${channelLabel(c.channel)} (${consented.join(" · ")})`
      : `${channelLabel(c.channel)} — no consent recorded`;
  });
  const first = channels.find((c) => typeof c.consent.granted_at === "string");
  const sub = first
    ? `granted via ${String(first.consent.source ?? "unknown source").replace(/_/g, " ")}, ${formatWhen(String(first.consent.granted_at))}`
    : null;
  return { line: parts.join(" · "), sub };
}

function KvRow({ k, v, sub }: { k: string; v: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="flex gap-2.5 text-[13px]">
      <span className="w-26 shrink-0 pt-0.5 font-mono text-[10.5px] tracking-wide text-ink-faint uppercase">
        {k}
      </span>
      <span className="min-w-0 font-medium">
        {v}
        {sub ? <span className="block text-[11.5px] font-normal text-ink-soft">{sub}</span> : null}
      </span>
    </div>
  );
}

export default async function EnquiryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const detail = await getEnquiryDetail(id);
  if (!detail) notFound();

  const client = detail.participants.find((p) => p.role === "client") ?? null;
  const others = detail.participants.filter((p) => p.role !== "client");
  const currentStage = detail.stages.find((s) => s.id === detail.stageId) ?? null;
  // The rail runs to the won terminal; a lost-type terminal shows as a red cell.
  const railStages = detail.stages.filter((s) => !s.isTerminal || s.terminalOutcome === "won");
  const offRail = currentStage && !railStages.some((s) => s.id === currentStage.id);
  const timeline = buildTimeline(detail);
  const notes = detail.comms.filter((c) => c.channel === "internal_note");
  const source = typeof detail.source.source === "string" ? detail.source.source : null;
  const consent = consentSummary(detail.clientChannels);

  return (
    <>
      <div className="mb-3.5">
        <Link
          href="/enquiries"
          className="font-mono text-xs font-semibold tracking-wide text-ink-soft hover:text-ink"
        >
          ← Back to Enquiries
        </Link>
      </div>

      <div className="glass rounded-xl p-5">
        <div className="flex flex-wrap items-start gap-3.5">
          <div>
            <h1 className="font-display text-[22px] font-extrabold tracking-tight">
              {client?.name ?? detail.title}
            </h1>
            <div className="mt-0.5 font-mono text-xs font-semibold text-ledger uppercase">
              {detail.visaRoute ?? "Route not yet classified"} · Enquiry{" "}
              {detail.id.slice(0, 8)}
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {source ? (
              <Badge variant="source">{source === "meta" ? "Meta lead form" : source}</Badge>
            ) : null}
            {detail.valueEstimate !== null ? (
              <Badge variant="green">est {formatGBP(detail.valueEstimate)}</Badge>
            ) : null}
            <Link
              href={`/record?entity_type=engagement&entity_id=${detail.id}`}
              className="font-mono text-[11px] font-semibold tracking-wide text-ledger uppercase hover:underline"
            >
              View on the Record →
            </Link>
          </div>
        </div>
        <div className="mt-4 flex gap-1 overflow-x-auto pb-1">
          {railStages.map((stage) => {
            const done = currentStage ? stage.sortOrder < currentStage.sortOrder : false;
            const now = stage.id === detail.stageId;
            return (
              <div
                key={stage.id}
                className={cn(
                  "min-w-[86px] flex-1 rounded-md px-1 py-1.5 text-center font-mono text-[9.5px] font-semibold tracking-wide uppercase",
                  now && "bg-ledger text-white",
                  done && !now && "bg-ledger-tint text-ledger",
                  !done && !now && "bg-paper-deep text-ink-faint"
                )}
              >
                {stage.label}
              </div>
            );
          })}
          {offRail && currentStage ? (
            <div className="min-w-[86px] flex-1 rounded-md bg-stamp px-1 py-1.5 text-center font-mono text-[9.5px] font-semibold tracking-wide text-white uppercase">
              {currentStage.label}
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-[1fr_328px] items-start gap-4 max-[980px]:grid-cols-1">
        <Panel title="Timeline — every touch, on every channel">
          <div className="relative px-4 pt-1.5 pb-4">
            <span className="absolute top-4 bottom-4 left-[29px] w-0.5 [background:repeating-linear-gradient(to_bottom,var(--color-rule)_0_5px,transparent_5px_10px)]" />
            {timeline.map((item) => (
              <TimelineEntry
                key={`${item.kind}-${item.kind === "comm" ? item.comm.id : item.kind === "stage" ? item.move.id : item.event.id}`}
                item={item}
                clientName={client?.name ?? null}
              />
            ))}
            {timeline.length === 0 ? (
              <div className="py-6 text-center font-mono text-[10px] tracking-wide text-ink-faint uppercase">
                Nothing on this enquiry yet
              </div>
            ) : null}
          </div>
        </Panel>

        <div className="flex flex-col gap-4">
          <Panel title="Enquiry file">
            <div className="flex flex-col gap-2.5 px-4 py-3.5">
              {client ? (
                <KvRow
                  k="Client"
                  v={
                    <Link href={`/contacts/${client.contactId}`} className="hover:underline">
                      {client.name}
                    </Link>
                  }
                  sub={`${client.locale} · ${client.status.replace(/_/g, " ")} · view contact →`}
                />
              ) : null}
              {others.map((p) => (
                <KvRow
                  key={`${p.contactId}-${p.role}`}
                  k={p.role.replace(/_/g, " ")}
                  v={
                    <Link href={`/contacts/${p.contactId}`} className="hover:underline">
                      {p.name}
                    </Link>
                  }
                  sub={p.type === "organisation" ? "organisation" : undefined}
                />
              ))}
              <KvRow
                k="Source"
                v={source === "meta" ? "Meta lead form" : (source ?? "Not recorded")}
                sub={
                  typeof detail.source.campaign_id === "string"
                    ? `campaign ${detail.source.campaign_id} · outcome will be reported back`
                    : undefined
                }
              />
              {consent ? <KvRow k="Consent" v={consent.line} sub={consent.sub} /> : null}
              {detail.valueEstimate !== null ? (
                <KvRow k="Value" v={`est ${formatGBP(detail.valueEstimate)}`} />
              ) : null}
              <KvRow k="Owner" v={detail.ownerName ?? "—"} sub="accountable human, never an agent" />
              <KvRow k="Opened" v={formatWhen(detail.createdAt)} />
            </div>
          </Panel>

          <Panel title="Tasks on this enquiry">
            <div className="flex flex-col gap-2 px-3 py-3">
              {detail.tasks.map((task) => {
                const done = task.status === "done";
                const byLight = task.assigneeType === "agent";
                return (
                  <div key={task.id} className="glass flex items-start gap-2.5 rounded-lg px-3 py-2.5">
                    <span
                      className={cn(
                        "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border-[1.5px]",
                        done ? "border-ledger bg-ledger text-[10px] text-white" : "border-ink-faint"
                      )}
                    >
                      {done ? "✓" : ""}
                    </span>
                    <span className="min-w-0 flex-1 text-[12.5px] font-medium">
                      <span className={cn(done && "text-ink-soft line-through")}>{task.title}</span>
                      <span className="mt-0.5 flex items-center gap-1 font-mono text-[10px] tracking-wide text-ink-faint uppercase">
                        {byLight ? <Sparkles className="size-3 text-gold" /> : null}
                        {task.assigneeName ?? "Unassigned"}
                        {task.dueAt ? ` · due ${formatWhen(task.dueAt)}` : ""}
                      </span>
                    </span>
                  </div>
                );
              })}
              {detail.tasks.length === 0 ? (
                <div className="py-4 text-center font-mono text-[10px] tracking-wide text-ink-faint uppercase">
                  No tasks on this enquiry
                </div>
              ) : null}
            </div>
          </Panel>

          <Panel title="Notes (internal)">
            <div className="px-4 py-3.5">
              {notes.map((note) => (
                <div
                  key={note.id}
                  className="mb-2 rounded-lg border border-gold-tint bg-gold-tint/60 px-3 py-2.5 text-[12.5px] last:mb-0"
                >
                  {note.body}
                  <div className="mt-1.5 font-mono text-[10px] tracking-wide text-ink-faint uppercase">
                    {note.draftedByName ?? "Internal"} · {formatWhen(note.occurredAt)} ·
                    internal_note — never visible to the client
                  </div>
                </div>
              ))}
              {notes.length === 0 ? (
                <div className="py-2 text-center font-mono text-[10px] tracking-wide text-ink-faint uppercase">
                  No internal notes yet
                </div>
              ) : null}
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
