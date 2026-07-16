import { PageHead } from "@/components/shell/page-head";

import { CreatePostButton } from "../social-shared";

/* view-soanalytics, master mockup v2 — the organic twin of the ads loop.
   No engagement events exist; every figure is an honest not-yet. */

function KpiBox({ label }: { label: string }) {
  return (
    <div className="glass rounded-lg px-3.5 py-3">
      <div className="font-mono text-[9.5px] tracking-[.12em] text-ink-faint uppercase">
        {label}
      </div>
      <div className="my-1 font-display text-[26px] font-extrabold text-ink-faint">—</div>
      <div className="text-[11.5px] leading-normal text-ink-soft">No events yet</div>
    </div>
  );
}

export default function SocialAnalyticsPage() {
  return (
    <>
      <PageHead
        title="Social"
        sub="The organic twin of the ads loop — engagement comes home as events"
        actions={<CreatePostButton />}
      />

      <div className="mb-3.5 flex flex-wrap items-center gap-2">
        {["7 days", "30 days", "90 days"].map((p, i) => (
          <span
            key={p}
            title="Periods recompute once engagement events exist"
            className={
              i === 0
                ? "rounded-2xl border border-ink bg-ink px-3 py-1 font-mono text-[11px] font-semibold tracking-wide text-paper uppercase"
                : "cursor-not-allowed rounded-2xl border border-rule bg-panel px-3 py-1 font-mono text-[11px] font-semibold tracking-wide text-ink-faint uppercase"
            }
          >
            {p}
          </span>
        ))}
      </div>

      <div className="mb-4 grid grid-cols-4 gap-3 max-[860px]:grid-cols-2">
        <KpiBox label="Reach" />
        <KpiBox label="Engagement" />
        <KpiBox label="Profile taps" />
        <KpiBox label="Enquiries from social" />
      </div>

      <div className="glass mb-4 overflow-hidden rounded-xl">
        <h2 className="border-b border-rule bg-paper px-4 py-3 font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-soft uppercase">
          When your audience is actually awake · reach by slot · ✦ suggested slot ringed
        </h2>
        <div className="px-4 py-8 text-center text-[13px] text-ink-soft">
          The heatmap draws from real reach events per slot — none exist yet.
          Light&rsquo;s slot suggestion on Home is born from this table, so it
          waits too.
        </div>
      </div>

      <div className="glass overflow-hidden rounded-xl">
        <h2 className="border-b border-rule bg-paper px-4 py-3 font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-soft uppercase">
          Top posts · by enquiries, not likes
        </h2>
        <div className="grid grid-cols-[1fr_110px_110px_110px] gap-3 border-b border-rule bg-accent-tint px-4 py-2.5 font-mono text-[9.5px] font-semibold tracking-[.14em] text-accent uppercase max-[640px]:grid-cols-[1fr_110px]">
          <span>Post</span>
          <span>Reach</span>
          <span className="max-[640px]:hidden">Taps</span>
          <span className="max-[640px]:hidden">Enquiries</span>
        </div>
        <div className="px-4 py-8 text-center text-[13px] text-ink-soft">
          No post has results yet — this table ranks real enquiries, never
          estimates.
        </div>
      </div>

      <p className="mt-3 font-mono text-xs text-ink-faint">
        METRICS ARRIVE AS EVENTS AND FEED THE SAME BRAIN — THE SLOT SUGGESTION ON HOME COMES
        FROM THIS TABLE. FULL META INSIGHTS VIA THE CONNECTED API; FIRST-PARTY ATTRIBUTION
        STITCHES TAP → SITE → FORM → PIPELINE.
      </p>
    </>
  );
}
