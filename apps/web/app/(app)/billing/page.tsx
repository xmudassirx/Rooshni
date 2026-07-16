import { PageHead } from "@/components/shell/page-head";
import { getCreditUsage } from "@/lib/server/queries";

export const dynamic = "force-dynamic";

/*
 * view-billing, master mockup v2: own the context, rent the intelligence.
 * Credit lines are REAL — every metered action is an event on The Record and
 * this page sums them. Plans, caps and platform invoices have no store yet;
 * those panels say so. Placement is settled by founder ruling (fix round):
 * a sidebar item, owner-gated.
 */

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

const DESIGNED_CAPS: [string, string][] = [
  ["Soft cap — warn", "a dashboard vigilance item when crossed; Light keeps working"],
  ["Hard cap — stop", "Light halts, queues work, tells you why — never a silent failure"],
  ["Per-action gate", "any single action over the threshold asks first — “this costs ~£4, proceed?”"],
  ["Intelligence tiers", "Standard for triage and routine drafts; Pro for complex drafting — the model router's bill, itemised"],
];

export default async function BillingPage() {
  const usage = await getCreditUsage();

  return (
    <>
      {/* Founder ruling (fix round): Billing stays a sidebar item, owner-gated
          — the placement question is closed and the proposal chip removed. */}
      <PageHead
        title="Billing & usage"
        sub="Own the context, rent the intelligence — and see exactly what the rent buys"
      />

      <div className="mb-4 grid grid-cols-3 gap-3 max-[860px]:grid-cols-1">
        <div className="glass rounded-lg px-3.5 py-3">
          <div className="font-mono text-[9.5px] tracking-[.12em] text-ink-faint uppercase">
            Plan
          </div>
          <div className="my-1 font-display text-xl font-extrabold text-ink-faint">
            Not yet set
          </div>
          <div className="text-[11.5px] leading-normal text-ink-soft">
            Plans and seats arrive with the billing session — nothing is being
            charged.
          </div>
        </div>
        <div className="glass rounded-lg px-3.5 py-3">
          <div className="font-mono text-[9.5px] tracking-[.12em] text-ink-faint uppercase">
            Credits used · this month
          </div>
          <div className="my-1 font-display text-[26px] font-extrabold">
            {usage.totalCredits}
            <span className="text-[13px] font-medium text-ink-soft"> credits · no cap set</span>
          </div>
          <div className="text-[11.5px] leading-normal text-ink-soft">
            Summed from the ledger — every metered action is an event.
          </div>
        </div>
        <div className="glass rounded-lg px-3.5 py-3">
          <div className="font-mono text-[9.5px] tracking-[.12em] text-ink-faint uppercase">
            This month bought
          </div>
          <div className="mt-1.5 text-[11.5px] leading-relaxed text-ink-soft">
            {usage.byAction.length
              ? usage.byAction
                  .slice(0, 4)
                  .map((a) => `${a.count} × ${a.action.replace(/[._]/g, " ")}`)
                  .join(" · ")
              : "Nothing metered yet."}{" "}
            Every credit line is an event on The Record.
          </div>
        </div>
      </div>

      <Panel title="Caps — the spend gate, set by you">
        {DESIGNED_CAPS.map(([k, v]) => (
          <div
            key={k}
            className="grid grid-cols-[250px_1fr] items-baseline gap-5 border-b border-rule px-5 py-3.5 text-[13.5px] last:border-b-0 max-[720px]:grid-cols-1"
          >
            <b>{k}</b>
            <span className="text-[12.5px] text-ink-soft">
              {v} — <i>not yet set; caps are enforced in the database when they land</i>
            </span>
          </div>
        ))}
      </Panel>

      <Panel title="Invoices · rows in money, like everything else">
        <div className="px-6 py-8 text-center text-[13px] text-ink-soft">
          No platform invoices yet — the first arrives with the billing session,
          as a PDF, a money row and a payment event: three faces of one fact.
        </div>
      </Panel>

      <p className="font-mono text-xs text-ink-faint">
        SIGNIFICANT CREDIT BURNS TRIGGER A GATE — AI SPEND RUNS THROUGH APPROVAL TOO (3.3/3.8).
        CAPS ARE ENFORCED IN THE DATABASE, NOT POLITENESS.
      </p>
    </>
  );
}
