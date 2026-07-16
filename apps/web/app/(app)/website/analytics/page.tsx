import { PageHead } from "@/components/shell/page-head";

export const dynamic = "force-dynamic";

/*
 * view-wsanalytics, master mockup v2: first-party analytics — KPI boxes,
 * the daily-visits bars, top pages by leads, and traffic sources. No site
 * events exist (no site is live), so every figure renders its honest
 * not-yet — the structure is the mockup's, the numbers are nobody's.
 */

function KpiBox({ label }: { label: string }) {
  return (
    <div className="glass rounded-lg px-3.5 py-3">
      <div className="font-mono text-[9.5px] tracking-[.12em] text-ink-faint uppercase">
        {label}
      </div>
      <div className="my-1 font-display text-[26px] font-extrabold text-ink-faint">—</div>
      <div className="text-[11.5px] leading-normal text-ink-soft">
        No site events yet
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="glass mb-4 overflow-hidden rounded-xl">
      <h2 className="border-b border-rule bg-paper px-4 py-3 font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-soft uppercase">
        {title}
      </h2>
      {children}
    </div>
  );
}

export default function WebsiteAnalyticsPage() {
  return (
    <>
      <PageHead
        title="Website"
        sub="First-party analytics — our pages, our events, measured at the source"
      />

      <div className="mb-3.5 flex flex-wrap items-center gap-2">
        {["7 days", "30 days", "90 days"].map((p, i) => (
          <span
            key={p}
            title="Periods recompute once site events exist"
            className={
              i === 0
                ? "rounded-2xl border border-ink bg-ink px-3 py-1 font-mono text-[11px] font-semibold tracking-wide text-paper uppercase"
                : "cursor-not-allowed rounded-2xl border border-rule bg-panel px-3 py-1 font-mono text-[11px] font-semibold tracking-wide text-ink-faint uppercase"
            }
          >
            {p}
          </span>
        ))}
        <span className="ml-auto font-mono text-[10px] text-ink-faint uppercase">
          VS previous period · week starts Monday
        </span>
      </div>

      <div className="mb-4 grid grid-cols-4 gap-3 max-[860px]:grid-cols-2">
        <KpiBox label="Visits" />
        <KpiBox label="Leads (forms)" />
        <KpiBox label="Visit → lead" />
        <KpiBox label="Consultations paid" />
      </div>

      <Panel title="Daily visits · this week vs last · tap a bar for the day">
        <div className="px-4 py-8 text-center text-[13px] text-ink-soft">
          The bars draw from first-party visit events — none have been recorded,
          because no site is live yet. An empty chart is the truth.
        </div>
      </Panel>

      <Panel title="Top pages · by leads, not vanity visits">
        <div className="px-4 py-8 text-center text-[13px] text-ink-soft">
          No page has earned a lead yet — this table ranks real form
          submissions, never estimates.
        </div>
      </Panel>

      <Panel title="Where visits come from · the organic twin of the ads loop">
        <div className="px-4 py-8 text-center text-[13px] text-ink-soft">
          Sources appear with the first measured visit.
        </div>
      </Panel>

      <p className="font-mono text-xs text-ink-faint">
        FIRST-PARTY ONLY IN PHASE 2 — VISITS, FORMS, PAYMENTS FROM OUR OWN EVENTS. RANKINGS,
        BACKLINKS, SEARCH CONSOLE = CONNECTED SURFACE, PHASE 3. NO THIRD-PARTY TRACKING PIXELS
        ON CLIENT PAGES WITHOUT CONSENT.
      </p>
    </>
  );
}
