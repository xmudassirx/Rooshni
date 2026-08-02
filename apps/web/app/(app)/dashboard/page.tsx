import Link from "next/link";
import { formatMeteredGbp } from "@rooshni/db";

import { BudgetBanner } from "@/components/shell/budget-banner";
import { EmptyState } from "@/components/shell/empty-state";
import { OpenFirstLightButton } from "@/components/shell/open-first-light";
import { PageHead } from "@/components/shell/page-head";
import { Button } from "@/components/ui/button";
import { durationSince, formatTime } from "@/lib/format";
import {
  getDashboard,
  getInboxSummary,
  getLightPerformance,
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

function typeBreakdown(byType: { type: string; count: number }[]): string {
  return byType
    .map(({ type, count }) => {
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
        tone === "gold" && "light-vitem"
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
  // WS5e (Session 22): the stamps-owed numbers are COUNT aggregates + one
  // oldest row — never a full inbox fetch to count it.
  const [dash, inbox, pipeline, perf] = await Promise.all([
    getDashboard(),
    getInboxSummary(),
    getPipeline(),
    getLightPerformance(),
  ]);

  const oldest = inbox.oldestAwaitingSince;

  // WS5e: stage sizes are the COUNT aggregates the query carries — the cards
  // themselves are a window and never the census.
  const stageCounts = pipeline.map((s) => ({
    label: s.label,
    count: s.total,
    hot: s.cards.some((c) => c.pendingApprovals > 0),
  }));
  const maxCount = Math.max(1, ...stageCounts.map((s) => s.count));
  const pipelineTotal = stageCounts.reduce((sum, s) => sum + s.count, 0);

  const monitorsClear = inbox.total === 0 && (dash.stuck?.length ?? 0) === 0;

  // Day one, before the first enquiry or stamp: the true empty state
  // (Session 11 mockup). It never shows an invented number — and it points
  // honestly at First Light instead of claiming a crawl that hasn't run.
  if (pipelineTotal === 0 && inbox.total === 0) {
    return (
      <>
        <PageHead title="Dashboard" sub="Your day, once there is one" />
        <EmptyState
          icon="▦"
          title="Nothing needs you yet — and that's the truth"
          action={<OpenFirstLightButton>Open First Light</OpenFirstLightButton>}
        >
          <p>
            This screen fills itself from real rows: enquiries that arrive,
            approvals waiting for your stamp, tasks due today. It will never
            show you an invented number.
          </p>
          <p>
            <span className="light-spark">✦</span> Your setup lives in{" "}
            <b>First Light</b>, top right — each row you finish brings your
            first enquiry closer.
          </p>
        </EmptyState>
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Dashboard"
        sub="Vigilance and tiles over live rows — attention curation arrives with the monitors session"
      />

      {/* WS2 (Session 22): the cap banner renders from live truth — soft
          warns, hard says generation is refusing; the ledger holds the
          crossing event once per month. */}
      <BudgetBanner
        softCapGbp={dash.budget.softCapGbp}
        hardCapGbp={dash.budget.hardCapGbp}
        softCrossed={dash.budget.softCrossed}
        hardCrossed={dash.budget.hardCrossed}
        spendGbp={dash.meteredCostGbpThisMonth}
      />

      {/* Morning digest — Light's slot. Light has not written one yet, and an
          unwritten digest never pretends otherwise (decision 19 caveat). */}
      <div className="light-panel mb-4 rounded-xl p-4">
        <div className="light-head mb-2 font-mono text-[10.5px] font-semibold tracking-[.14em] uppercase">
          ✦ Morning digest
        </div>
        <div className="max-w-[75ch] text-[14.5px] leading-relaxed">
          Light hasn&rsquo;t watched a night here yet — the narrated digest
          arrives with the monitors session. Until then, the vigilance list and
          the tiles below read straight from live rows:{" "}
          <b>
            {dash.newToday} new enquir{dash.newToday === 1 ? "y" : "ies"} today
          </b>
          {" · "}
          <b>
            {inbox.total} stamp{inbox.total === 1 ? "" : "s"} owed
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
      {inbox.total > 0 ? (
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
            {inbox.total} approval{inbox.total === 1 ? "" : "s"} waiting:
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
      <div className="mt-4 grid grid-cols-1 gap-3 min-[680px]:grid-cols-2 min-[1600px]:grid-cols-4">
        <Tile href="/inbox" head="Stamps owed">
          <div className="font-display text-3xl leading-none font-black">
            {inbox.total}
          </div>
          <div className="mt-1.5 text-xs text-ink-soft">
            {inbox.total
              ? `${typeBreakdown(inbox.byType)} — oldest ${oldest ? durationSince(oldest) : "—"}`
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

        {/* WS3 (Session 22): the shadow-exit calibration instrument — existing
            truth only (events + draft_feedback + communication statuses),
            honest empty states, no model calls. */}
        <Tile href="/record" head="✦ Light performance · this week">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <div>
              <span className="font-display text-[22px] leading-none font-black">
                {perf.approval_rate_pct !== null ? `${perf.approval_rate_pct}%` : "—"}
              </span>{" "}
              <span className="text-[10.5px] text-ink-faint">approval</span>
            </div>
            <div>
              <span className="font-display text-[22px] leading-none font-black">
                {perf.edit_rate_pct !== null ? `${perf.edit_rate_pct}%` : "—"}
              </span>{" "}
              <span className="text-[10.5px] text-ink-faint">edit-before-stamp</span>
            </div>
          </div>
          <div className="mt-1.5 text-xs leading-relaxed text-ink-soft">
            {perf.drafts_generated
              ? `${perf.drafts_generated} draft${perf.drafts_generated === 1 ? "" : "s"} generated · ${perf.stamped} stamped · ${perf.rejected} rejected · ${perf.compliance_refusals} compliance refusal${perf.compliance_refusals === 1 ? "" : "s"} · ${perf.mean_tokens !== null ? `${perf.mean_tokens.toLocaleString("en-GB")} mean tokens` : "no token data"} · ${formatMeteredGbp(perf.spend_gbp)} spend`
              : "No drafts generated this week — the tile fills itself from The Record, never invention."}
            {perf.approval_rate_pct === null && perf.drafts_generated > 0
              ? " No stamps or rejections yet this week, so no rate is claimed."
              : ""}
          </div>
        </Tile>

        <Tile href="/billing" head="Metered cost · this month">
          {/* Session 23 (WS1d): precision-aware — a sub-penny month shows
              its real figure, never a rounded-up penny. */}
          <div className="font-display text-[22px] leading-none font-black">
            {formatMeteredGbp(dash.meteredCostGbpThisMonth)}
          </div>
          <div className="mt-1.5 text-xs text-ink-soft">
            {dash.meteredEventsThisMonth
              ? `${dash.meteredEventsThisMonth} metered action${dash.meteredEventsThisMonth === 1 ? "" : "s"} on The Record this month${
                  dash.unpricedEventsThisMonth
                    ? ` (${dash.unpricedEventsThisMonth} pre-meter, unpriced)`
                    : ""
                }.`
              : "No metered actions on The Record this month."}{" "}
            {dash.budget.hardCapGbp !== null || dash.budget.softCapGbp !== null
              ? "Caps set in Billing & usage."
              : "No caps set — Billing & usage is the door."}
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
