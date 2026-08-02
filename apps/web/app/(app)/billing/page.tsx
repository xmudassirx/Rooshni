import { formatMeteredGbp } from "@rooshni/db";

import { PageHead } from "@/components/shell/page-head";
import { BudgetBanner } from "@/components/shell/budget-banner";
import { getMeteredUsage } from "@/lib/server/queries";
import { CapsForm } from "./caps-form";

export const dynamic = "force-dynamic";

/*
 * view-billing, master mockup v2 — Session 22 (WS2) makes it real: monthly
 * metered spend from events.cost (the s15 producer), by day and by action
 * kind; the dashboard tile reads the same truth. Figures are labelled
 * METERED COST honestly — our recorded cost at provider list rates, no
 * margin invented; pilot pricing is a founder decision later (ruling 2a).
 * Caps are owner-set here (2b); enforcement is server-side in the drafting
 * path. No payment collection (2c). Placement settled by founder ruling: a
 * sidebar item, owner-gated.
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

// Session 23 (WS1d): displays share the precision-aware formatter — a
// sub-penny spend shows 3dp, so a £0.01 cap beside £0.006 of spend is
// explicable; the cap comparison itself always ran on raw amounts.
const gbp = formatMeteredGbp;

function actionLabel(action: string): string {
  return action.replace(/[._]/g, " ");
}

export default async function BillingPage() {
  const usage = await getMeteredUsage();

  return (
    <>
      <PageHead
        title="Billing & usage"
        sub="Own the context, rent the intelligence — and see exactly what the rent buys"
      />

      <BudgetBanner
        softCapGbp={usage.budget.softCapGbp}
        hardCapGbp={usage.budget.hardCapGbp}
        softCrossed={usage.budget.softCrossed}
        hardCrossed={usage.budget.hardCrossed}
        spendGbp={usage.totalGbp}
        showBillingLink={false}
      />

      <div className="mb-4 grid grid-cols-3 gap-3 max-[860px]:grid-cols-1">
        <div className="glass rounded-lg px-3.5 py-3">
          <div className="font-mono text-[9.5px] tracking-[.12em] text-ink-faint uppercase">
            Metered cost · this month
          </div>
          <div className="my-1 font-display text-[26px] font-extrabold">
            {gbp(usage.totalGbp)}
            <span className="text-[13px] font-medium text-ink-soft">
              {" "}
              · {usage.pricedLines} priced line{usage.pricedLines === 1 ? "" : "s"}
            </span>
          </div>
          <div className="text-[11.5px] leading-normal text-ink-soft">
            Our recorded cost at provider list rates — no margin invented; pilot pricing is a
            separate decision.
            {usage.unpricedLines > 0
              ? ` ${usage.unpricedLines} earlier line${usage.unpricedLines === 1 ? "" : "s"} (${usage.unpricedTokens.toLocaleString("en-GB")} tokens) predate the meter and are never retro-priced.`
              : ""}
          </div>
        </div>
        <div className="glass rounded-lg px-3.5 py-3">
          <div className="font-mono text-[9.5px] tracking-[.12em] text-ink-faint uppercase">
            Caps · this month
          </div>
          <div className="my-1 font-display text-xl font-extrabold">
            {usage.budget.softCapGbp !== null || usage.budget.hardCapGbp !== null ? (
              <>
                {usage.budget.softCapGbp !== null ? `warn ${gbp(usage.budget.softCapGbp)}` : "no warn"}
                {" · "}
                {usage.budget.hardCapGbp !== null ? `stop ${gbp(usage.budget.hardCapGbp)}` : "no stop"}
              </>
            ) : (
              <span className="text-ink-faint">none set</span>
            )}
          </div>
          <div className="text-[11.5px] leading-normal text-ink-soft">
            {usage.budget.hardCrossed
              ? "Hard cap reached — generation is refusing with the cap named."
              : usage.budget.softCrossed
                ? "Soft cap crossed — warning only, nothing blocked."
                : "Set below; enforced server-side in the drafting path, not politeness."}
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
                  .map((a) => `${a.lines} × ${actionLabel(a.action)}`)
                  .join(" · ")
              : "Nothing metered yet."}{" "}
            Every credit line is an event on The Record.
          </div>
        </div>
      </div>

      <Panel title="Caps — the spend gate, set by you">
        <CapsForm
          softCapGbp={usage.budget.softCapGbp}
          hardCapGbp={usage.budget.hardCapGbp}
          isOwner={usage.isOwner}
        />
      </Panel>

      <Panel title="Metered cost by action kind · this month">
        {usage.byAction.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-[12.5px]">
              <thead>
                <tr className="border-b border-rule font-mono text-[9.5px] tracking-[.12em] text-ink-faint uppercase">
                  <th className="px-5 py-2 text-left font-semibold">Action</th>
                  <th className="px-3 py-2 text-right font-semibold">Lines</th>
                  <th className="px-3 py-2 text-right font-semibold">Tokens</th>
                  <th className="px-5 py-2 text-right font-semibold">Metered cost</th>
                </tr>
              </thead>
              <tbody>
                {usage.byAction.map((a) => (
                  <tr key={a.action} className="border-b border-rule last:border-b-0">
                    <td className="px-5 py-2 font-mono text-[11.5px]">{a.action}</td>
                    <td className="px-3 py-2 text-right">{a.lines}</td>
                    <td className="px-3 py-2 text-right">{a.tokens.toLocaleString("en-GB")}</td>
                    <td className="px-5 py-2 text-right font-semibold">
                      {a.gbp > 0 ? `£${a.gbp.toFixed(4)}` : "unpriced"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="px-6 py-8 text-center text-[13px] text-ink-soft">
            No metered actions this month — the meter fills itself from The Record.
          </div>
        )}
      </Panel>

      <Panel title="Metered cost by day · this month">
        {usage.byDay.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[360px] text-[12.5px]">
              <thead>
                <tr className="border-b border-rule font-mono text-[9.5px] tracking-[.12em] text-ink-faint uppercase">
                  <th className="px-5 py-2 text-left font-semibold">Day</th>
                  <th className="px-3 py-2 text-right font-semibold">Lines</th>
                  <th className="px-5 py-2 text-right font-semibold">Metered cost</th>
                </tr>
              </thead>
              <tbody>
                {usage.byDay.map((d) => (
                  <tr key={d.day} className="border-b border-rule last:border-b-0">
                    <td className="px-5 py-2 font-mono text-[11.5px]">{d.day}</td>
                    <td className="px-3 py-2 text-right">{d.lines}</td>
                    <td className="px-5 py-2 text-right font-semibold">
                      {d.gbp > 0 ? `£${d.gbp.toFixed(4)}` : "unpriced"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="px-6 py-8 text-center text-[13px] text-ink-soft">
            No metered actions this month.
          </div>
        )}
      </Panel>

      <Panel title="Invoices · rows in money, like everything else">
        <div className="px-6 py-8 text-center text-[13px] text-ink-soft">
          No platform invoices yet — no payment is collected here (the meter and the caps only);
          Stripe billing for pilots is priced later.
        </div>
      </Panel>

      <p className="font-mono text-xs text-ink-faint">
        FIGURES ARE METERED COST — PROVIDER LIST RATES, RECORDED FX, NO MARGIN. THE HARD CAP IS
        ENFORCED IN THE DRAFTING PATH SERVER-SIDE; THE APPROVAL GATE NEVER MOVES.
      </p>
    </>
  );
}
