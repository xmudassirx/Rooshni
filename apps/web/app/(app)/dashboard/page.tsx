import Link from "next/link";

import { PageHead } from "@/components/shell/page-head";
import { Button } from "@/components/ui/button";
import { durationSince, formatTime } from "@/lib/format";
import {
  getDashboard,
  getInbox,
  getPipeline,
  type StuckEnquiry,
} from "@/lib/server/queries";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const ITEM_TYPE_LABELS: Record<string, [string, string]> = {
  communication: ["message", "messages"],
  content: ["content item", "content items"],
  spend: ["spend gate", "spend gates"],
  grant: ["grant", "grants"],
  workflow: ["workflow", "workflows"],
  stage_move: ["stage move", "stage moves"],
};

function typeBreakdown(byType: Map<string, number>): string {
  return [...byType.entries()]
    .map(([type, count]) => {
      const [one, many] = ITEM_TYPE_LABELS[type] ?? [type, `${type}s`];
      return `${count} ${count === 1 ? one : many}`;
    })
    .join(" · ");
}

function VigilanceItem({
  tone,
  action,
  monitor,
  children,
}: {
  tone: "red" | "amber" | "gold";
  action?: React.ReactNode;
  monitor: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "glass mb-2 flex flex-wrap items-start gap-3 rounded-lg border-l-4 p-3",
        tone === "red" && "border-l-stamp",
        tone === "amber" && "border-l-amber",
        tone === "gold" && "border-l-gold"
      )}
    >
      <div className="min-w-0 flex-1 text-[13.5px]">
        {children}
        <small className="mt-1 block font-mono text-[10px] tracking-[.04em] text-ink-faint uppercase">
          {monitor}
        </small>
      </div>
      {action ? <div className="flex shrink-0 flex-wrap gap-1.5">{action}</div> : null}
    </div>
  );
}

function Tile({
  href,
  head,
  children,
}: {
  href: string;
  head: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="glass block rounded-xl p-4 transition-colors hover:border-accent"
    >
      <div className="mb-2.5 flex items-center gap-2 font-mono text-[10px] font-semibold tracking-[.12em] text-ink-faint uppercase">
        {head}
      </div>
      {children}
    </Link>
  );
}

function StuckItems({ stuck }: { stuck: StuckEnquiry[] }) {
  return (
    <>
      {stuck.slice(0, 3).map((s) => (
        <VigilanceItem
          key={s.id}
          tone="amber"
          monitor="Monitor: stage SLA (stage_definitions.sla_hours) · advise-only — Light never acts past a gate"
          action={
            <Button asChild size="sm">
              <Link href={`/enquiries/${s.id}`}>Open enquiry</Link>
            </Button>
          }
        >
          <b>Stuck enquiry:</b> {s.title} has sat in <i>{s.stageLabel}</i> for{" "}
          {durationSince(s.stageEnteredAt)} — the stage SLA is {s.slaHours}h.
        </VigilanceItem>
      ))}
    </>
  );
}

export default async function DashboardPage() {
  const [dash, inbox, pipeline] = await Promise.all([
    getDashboard(),
    getInbox(),
    getPipeline(),
  ]);

  const byType = new Map<string, number>();
  for (const row of inbox) {
    byType.set(row.item_type, (byType.get(row.item_type) ?? 0) + 1);
  }
  const oldest = inbox[0]?.awaiting_since ?? null;

  const stageCounts = pipeline.map((s) => ({
    label: s.label,
    count: s.cards.length,
    hot: s.cards.some((c) => c.pendingApprovals > 0),
  }));
  const maxCount = Math.max(1, ...stageCounts.map((s) => s.count));
  const pipelineTotal = stageCounts.reduce((sum, s) => sum + s.count, 0);

  const monitorsClear = inbox.length === 0 && (dash.stuck?.length ?? 0) === 0;

  return (
    <>
      <PageHead
        title="Dashboard"
        sub="Vigilance and tiles over live rows — attention curation arrives with the monitors session"
      />

      {/* Morning digest — Light's slot. Light has not written one yet, and an
          unwritten digest never pretends otherwise (decision 19 caveat). */}
      <div className="light-panel mb-4 rounded-xl p-4">
        <div className="light-head mb-2 font-mono text-[10.5px] font-semibold tracking-[.14em] uppercase">
          ✦ Morning digest
        </div>
        <div className="text-[14.5px] leading-relaxed">
          Light hasn&rsquo;t watched a night here yet — the narrated digest
          arrives with the monitors session. Until then, the vigilance list and
          the tiles below read straight from live rows:{" "}
          <b>
            {dash.newToday} new enquir{dash.newToday === 1 ? "y" : "ies"} today
          </b>
          {" · "}
          <b>
            {inbox.length} stamp{inbox.length === 1 ? "" : "s"} owed
          </b>
          {" · "}
          <b>
            {dash.todaySchedule.length} task
            {dash.todaySchedule.length === 1 ? "" : "s"} on today&rsquo;s list
          </b>
          .
        </div>
      </div>

      {/* Vigilance — deterministic monitors only; nothing invented. */}
      {inbox.length > 0 ? (
        <VigilanceItem
          tone="red"
          monitor="Monitor: inbox age · advise-only — Light never acts past a gate"
          action={
            <Button asChild size="sm">
              <Link href="/inbox">Open inbox</Link>
            </Button>
          }
        >
          <b>
            {inbox.length} approval{inbox.length === 1 ? "" : "s"} waiting:
          </b>{" "}
          the oldest has waited {oldest ? durationSince(oldest) : "—"} for your
          stamp.
        </VigilanceItem>
      ) : null}
      {dash.stuck ? (
        <StuckItems stuck={dash.stuck} />
      ) : (
        <p className="mb-2 font-mono text-[11px] text-ink-faint uppercase">
          Stage SLA monitor needs TIME_SCALE — unset in this environment, so it
          honestly cannot run.
        </p>
      )}
      {monitorsClear ? (
        <p className="mb-2 font-mono text-[11px] tracking-[.04em] text-ink-faint uppercase">
          Monitors clear — no approvals waiting, no stage SLA breaches.
        </p>
      ) : null}

      {/* Curated tiles */}
      <div className="mt-4 grid grid-cols-1 gap-3 min-[680px]:grid-cols-2">
        <Tile href="/inbox" head="Stamps owed">
          <div className="font-display text-3xl leading-none font-black">
            {inbox.length}
          </div>
          <div className="mt-1.5 text-xs text-ink-soft">
            {inbox.length
              ? `${typeBreakdown(byType)} — oldest ${oldest ? durationSince(oldest) : "—"}`
              : "Nothing waits for your stamp."}
          </div>
        </Tile>

        <Tile
          href="/enquiries"
          head={`Live pipeline · ${pipelineTotal} enquir${pipelineTotal === 1 ? "y" : "ies"}`}
        >
          <div className="mt-2 flex h-11 items-end gap-1">
            {stageCounts.map((s) => (
              <div
                key={s.label}
                title={`${s.label}: ${s.count}`}
                className={cn(
                  "flex-1 rounded-t",
                  s.hot ? "bg-accent" : "bg-accent-tint"
                )}
                style={{ height: `${Math.max(8, (s.count / maxCount) * 100)}%` }}
              />
            ))}
          </div>
          <div className="mt-1.5 text-xs text-ink-soft">
            {stageCounts.map((s) => `${s.label} ${s.count}`).join(" · ")}
          </div>
        </Tile>

        <Tile href="/tasks" head="Today">
          {dash.todaySchedule.length ? (
            <div className="mt-1 flex flex-col gap-1.5">
              {dash.todaySchedule.map((t) => (
                <div key={t.id} className="flex items-baseline gap-2 text-[12.5px]">
                  <span className="w-13 shrink-0 font-mono text-[10.5px] text-ink-faint">
                    {t.dueAt ? formatTime(t.dueAt).slice(0, 5) : "—"}
                  </span>
                  <span className="min-w-0 truncate">
                    {t.byLight ? <span className="light-text">✦ </span> : null}
                    {t.title}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-ink-soft">
              Nothing due today — open tasks live under Tasks.
            </div>
          )}
        </Tile>

        <Tile href="/record" head="AI credits · this month">
          <div className="font-display text-[22px] leading-none font-black">
            {dash.creditsThisMonth} credit{dash.creditsThisMonth === 1 ? "" : "s"}
          </div>
          <div className="mt-1.5 text-xs text-ink-soft">
            {dash.meteredEventsThisMonth
              ? `${dash.meteredEventsThisMonth} metered action${dash.meteredEventsThisMonth === 1 ? "" : "s"} on The Record this month.`
              : "No metered actions on The Record this month."}{" "}
            Caps and the meter arrive with Billing &amp; usage.
          </div>
        </Tile>
      </div>

      <p className="mt-3.5 font-mono text-xs text-ink-faint">
        VIGILANCE IS EVENT-DRIVEN, NOT ALWAYS-RUNNING: DETERMINISTIC MONITORS +
        THIS DIGEST IN PHASE 1 · MODEL SWEEPS ARRIVE PHASE 2 · EVERY SUGGESTION
        IS LEVEL 0 — ACTIONS STILL CLIMB THE LADDER.
      </p>
    </>
  );
}
