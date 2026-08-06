import Link from "next/link";
import { notFound } from "next/navigation";
import { Paperclip } from "lucide-react";


import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { buildTimeline, type TimelineItem as LibTimelineItem } from "@/lib/enquiry-timeline";
import { formatGBP, formatWhen } from "@/lib/format";
import { describeEvent } from "@/lib/record-language";
import {
  getEnquiryDetail,
  getViewerStampAuthority,
  type ChannelConsent,
  type EnquiryComm,
  type EnquiryStageMove,
  type RecordEvent,
} from "@/lib/server/queries";
import { cn } from "@/lib/utils";
import { RetrySendControl } from "../../inbox/retry-send-control";
import { RouteReclassifyControl } from "../route-control";
import { StageMoveControl } from "../stage-control";

export const dynamic = "force-dynamic";

/*
 * Enquiry detail — one lead's whole story on one screen, read-only. The
 * timeline merges three sources over the same database every other face
 * reads: the events ledger, stage_history, and communications. Approving
 * lives in the Approval Inbox; pending drafts here link across to it.
 */

/* Session 30 (177e): the timeline's merge-and-order lives in the pure
 * lib/enquiry-timeline module — NEWEST FIRST, every kind (events, stage
 * moves, message cards and their pins) in the one sort — so the harness
 * proves the ordering law the page renders. */
type TimelineItem = LibTimelineItem<RecordEvent, EnquiryStageMove, EnquiryComm>;

function Pin({ tone }: { tone: "neutral" | "gold" | "red" | "green" }) {
  return (
    <span
      className={cn(
        "absolute top-3.5 left-[5px] z-1 size-4.5 rounded-full border-2",
        tone === "gold" && "light-pin",
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

function CommCard({
  comm,
  clientName,
  viewerCanStamp,
}: {
  comm: EnquiryComm;
  clientName: string | null;
  viewerCanStamp: boolean;
}) {
  const byLight = comm.draftedByType === "agent";
  const inbound = comm.direction === "inbound";
  const pending = comm.status === "pending_approval";
  // Defect-pair hotfix (2 Aug 2026, item 1): FAIL-LOUD reaches the timeline
  // — a failed dispatch pins and badges RED with the recorded reason.
  const failed = comm.status === "failed";
  const tone = failed ? "red" : pending || byLight ? "gold" : "neutral";

  // Session 27 (D158a): the returning-lead system marker — a fact in
  // NEUTRAL chrome (not Light's act, not a human's), changed fields
  // highlighted.
  if (comm.returningMarker) {
    const marker = comm.returningMarker;
    return (
      <div className="relative py-3 pl-10.5">
        <Pin tone="neutral" />
        <When>
          {formatWhen(marker.submittedAt ?? comm.occurredAt)} · system marker
        </When>
        <div className="mt-0.5 text-[13.5px]">
          <b>Form submitted again</b>
          {marker.formLabel ? <> — {marker.formLabel}</> : null}
        </div>
        <div className="glass mt-2 rounded-lg p-3 text-[12.5px]">
          <div className="flex flex-col gap-0.5 font-mono text-[10.5px] tracking-wide">
            {marker.answers.map((a) => (
              <span key={`${a.label}-${a.value}`}>
                <span className="text-ink-faint uppercase">{a.label}:</span>{" "}
                <span
                  className={
                    a.changed ? "rounded-sm bg-accent/12 px-1 font-semibold text-accent" : "text-ink"
                  }
                >
                  {a.value || "(blank)"}
                </span>
                {a.changed && a.previousValue !== null ? (
                  <span className="text-ink-faint"> (was {a.previousValue})</span>
                ) : a.changed ? (
                  <span className="text-ink-faint"> (new)</span>
                ) : null}
              </span>
            ))}
          </div>
          <div className="mt-1.5 font-mono text-[10px] tracking-wide text-ink-faint uppercase">
            internal marker — never sent to the client
          </div>
        </div>
      </div>
    );
  }

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
          {failed ? <Badge variant="red">✗ send failed</Badge> : null}
          {comm.status === "draft" && comm.rejection ? (
            <Badge variant="gold">returned to Light&apos;s queue</Badge>
          ) : null}
          {comm.scheduledFor ? (
            <Badge variant="time">scheduled {formatWhen(comm.scheduledFor)}</Badge>
          ) : null}
          {/* Session 27 (D160): the timeline's draft entry shows attachment
              state — the same fact the inbox card shows at the stamp. */}
          {comm.attachments.map((a) => (
            <Badge key={a.filename} variant="source">
              <Paperclip className="mr-1 inline size-3" aria-hidden />
              {a.filename}
            </Badge>
          ))}
        </div>
        <div className="whitespace-pre-wrap text-ink">{comm.body}</div>
        {/* Session 30 (177b): rejection is the stamp withheld and wears the
            stamp's colour — the ruled grammar, the fail-loud red rule. */}
        {comm.rejection ? (
          <div className="mt-2 border-t border-dashed border-stamp/40 pt-2 text-[12px] text-stamp">
            Rejected by {comm.rejection.byName} · {comm.rejection.reason}
            <span className="mt-0.5 block font-mono text-[10px] tracking-wide text-ink-faint">
              {formatWhen(comm.rejection.at)}
            </span>
          </div>
        ) : null}
        {failed ? (
          <div className="mt-2 border-t border-dashed border-stamp/40 pt-2 text-[12px] text-stamp">
            Send failed
            {comm.sendFailure?.failedAt ? `, ${formatWhen(comm.sendFailure.failedAt)}` : ""} —{" "}
            {comm.sendFailure
              ? `${comm.sendFailure.provider ? `${comm.sendFailure.provider}: ` : ""}${comm.sendFailure.reason}`
              : "the provider refused the message; reason on The Record"}
            {viewerCanStamp ? (
              <span className="mt-1.5 block">
                <RetrySendControl communicationId={comm.id} />
              </span>
            ) : null}
          </div>
        ) : null}
        {/* JUDGMENT: the mockup shows Approve/Refine controls here; this session
            is read-only screens only, so a pending draft links across to the
            Approval Inbox — approving from the timeline is the same act on the
            same row and arrives with a write-path session. */}
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

function TimelineEntry({
  item,
  clientName,
  viewerCanStamp,
}: {
  item: TimelineItem;
  clientName: string | null;
  viewerCanStamp: boolean;
}) {
  if (item.kind === "comm") {
    return <CommCard comm={item.comm} clientName={clientName} viewerCanStamp={viewerCanStamp} />;
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
  // Session 25 (founder-ordered fail-loud): a refused draft generation wears
  // RED on the timeline with the RECORDED reason — never invented, never
  // summarised. JUDGMENT: "Ask Light to draft again" is a live act only on a
  // conversation thread (askLightToDraftAction), so a comm_thread refusal
  // links across to it (the timeline's read-only precedent — pending drafts
  // link to the inbox); a workflow_run refusal names the refusal and its
  // reason with no dead control (decision 116).
  if (item.event.action === "light.draft_generation_failed") {
    const reason =
      typeof item.event.payload.reason === "string" && item.event.payload.reason.trim() !== ""
        ? item.event.payload.reason
        : "no reason recorded";
    const transient = item.event.payload.transient === true;
    const threadId = item.event.entityType === "comm_thread" ? item.event.entityId : null;
    return (
      <div className="relative py-3 pl-10.5">
        <Pin tone="red" />
        <When>
          {formatWhen(item.event.occurredAt)} · {item.event.actorName}
        </When>
        <div className="mt-0.5 text-[13.5px]">
          <b>Light&rsquo;s draft was refused:</b>{" "}
          <span className="text-stamp">{reason}</span>
          {transient ? (
            <span className="block text-[11.5px] text-ink-soft">
              transient, Light retries automatically
            </span>
          ) : null}
          {threadId && !transient ? (
            <Link
              href={`/conversations?thread=${threadId}`}
              className="mt-0.5 block font-mono text-[10px] font-semibold tracking-wide text-accent uppercase hover:underline"
            >
              Ask Light to draft again →
            </Link>
          ) : null}
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
  const [detail, viewerCanStamp] = await Promise.all([
    getEnquiryDetail(id),
    getViewerStampAuthority(),
  ]);
  if (!detail) notFound();

  const client = detail.participants.find((p) => p.role === "client") ?? null;
  const others = detail.participants.filter((p) => p.role !== "client");
  const currentStage = detail.stages.find((s) => s.id === detail.stageId) ?? null;
  // JUDGMENT: the mockup's rail shows only the happy path to Instructed. The
  // lost-type terminals (Closed-lost, Unresponsive, Disqualified) join the rail
  // as a single red cell only when the enquiry actually sits in one — red is
  // the human-stamp register, and a dead enquiry died by someone's decision.
  const railStages = detail.stages.filter((s) => !s.isTerminal || s.terminalOutcome === "won");
  const offRail = currentStage && !railStages.some((s) => s.id === currentStage.id);
  const timeline = buildTimeline(detail);
  const notes = detail.comms.filter((c) => c.channel === "internal_note");
  const source = typeof detail.source.source === "string" ? detail.source.source : null;
  const consent = consentSummary(detail.clientChannels);

  // Session 27 (D161): the route's story — value, provenance, and the last
  // route_set event's recorded reason and actor.
  const routeLabel = detail.visaRoute
    ? (detail.routeOptions.find((o) => o.key === detail.visaRoute)?.label ?? detail.visaRoute)
    : null;
  const lastRouteSet = [...detail.events].reverse().find((e) => e.action === "engagement.route_set");
  const routeReason =
    lastRouteSet && typeof lastRouteSet.payload.reason === "string" ? lastRouteSet.payload.reason : null;
  const routeSetter = lastRouteSet?.actorName ?? null;
  const routeSourceLine =
    detail.visaRouteSource === "light"
      ? `set by Light${routeReason ? ` — “${routeReason}”` : ""}`
      : detail.visaRouteSource === "human"
        ? `set by ${routeSetter ?? "a team member"}${routeReason ? ` — “${routeReason}”` : ""}`
        : detail.visaRouteSource === "form_answer"
          ? "from the form's own answer"
          : detail.visaRouteSource === "form_default"
            ? "form default"
            : null;

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
            {/* JUDGMENT: the mockup shows "ENQUIRY #0114" but the schema has no
                sequence number and adding one is Session 6's fence — the first
                block of the uuid stands in as the reference for now. */}
            {/* Session 27 (D160/D161): the route line tells the truth of its
                moment — "classifying" only while a read may still arrive; the
                provenance chip wears gold ONLY for Light's hand (colour law). */}
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-xs font-semibold text-ledger uppercase">
              <span>
                {routeLabel ?? (detail.classifying ? "Classifying route…" : "Route not yet classified")} ·
                Enquiry {detail.id.slice(0, 8)}
              </span>
              {routeSourceLine ? (
                <Badge variant={detail.visaRouteSource === "light" ? "gold" : "source"}>
                  {detail.visaRouteSource === "light" ? "✦ " : ""}
                  {routeSourceLine}
                </Badge>
              ) : null}
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
                viewerCanStamp={viewerCanStamp}
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
              {/* Session 30 (177f): the stage is human-movable — the
                  installed template's stages plus its terminal states; the
                  0015/0016 doors enforce access, the act is evented, and a
                  human move is a fact the workflow respects. */}
              <KvRow
                k="Stage"
                v={
                  <>
                    {currentStage?.label ?? "—"}
                    <span className="ml-2 inline-block">
                      <StageMoveControl
                        engagementId={detail.id}
                        currentStageId={detail.stageId}
                        stages={detail.stages}
                      />
                    </span>
                  </>
                }
                sub={
                  currentStage?.isTerminal
                    ? `terminal — ${currentStage.terminalOutcome ?? "closed"}`
                    : undefined
                }
              />
              {/* Session 27 (D161c): the route field, editable by any team
                  member with enquiry access — the 0042 door enforces the
                  ladder; a human-set route is final against machine writes. */}
              <KvRow
                k="Route"
                v={
                  <>
                    {routeLabel ??
                      (detail.classifying ? "Classifying…" : "Not yet classified")}
                    <span className="ml-2 inline-block">
                      <RouteReclassifyControl
                        engagementId={detail.id}
                        currentRoute={detail.visaRoute}
                        options={detail.routeOptions}
                      />
                    </span>
                  </>
                }
                sub={routeSourceLine ?? undefined}
              />
              {detail.predecessor ? (
                <KvRow
                  k="Previous"
                  v={
                    <Link href={`/enquiries/${detail.predecessor.id}`} className="hover:underline">
                      {detail.predecessor.title}
                    </Link>
                  }
                  sub="this enquiry was opened by a returning submission"
                />
              ) : null}
              {detail.successors.map((s) => (
                <KvRow
                  key={s.id}
                  k="Continued"
                  v={
                    <Link href={`/enquiries/${s.id}`} className="hover:underline">
                      {s.title}
                    </Link>
                  }
                  sub="a returning submission opened this newer enquiry"
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
                        {byLight ? (
                          <span className="light-spark text-[11px] leading-none">✦</span>
                        ) : null}
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
                  className="light-panel mb-2 rounded-lg px-3 py-2.5 text-[12.5px] last:mb-0"
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
