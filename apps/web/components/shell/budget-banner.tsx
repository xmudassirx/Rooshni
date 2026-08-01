import Link from "next/link";
import { cn } from "@/lib/utils";

/*
 * Session 22 (WS2, ruling 2b) — the cap banners, rendered from live truth
 * (the pages compute the assessment server-side each render; the ledger
 * holds the crossing event once per month). Soft crossed = a visible warning
 * that blocks nothing (amber). Hard crossed = generation is refusing and
 * says so (RED is the overdue/stop register — decision 61 keeps it away
 * from chrome).
 */

export function BudgetBanner({
  softCapGbp,
  hardCapGbp,
  softCrossed,
  hardCrossed,
  spendGbp,
  showBillingLink = true,
}: {
  softCapGbp: number | null;
  hardCapGbp: number | null;
  softCrossed: boolean;
  hardCrossed: boolean;
  spendGbp: number;
  showBillingLink?: boolean;
}) {
  if (!softCrossed && !hardCrossed) return null;
  const hard = hardCrossed && hardCapGbp !== null;
  return (
    <div
      className={cn(
        "glass mb-3 flex flex-wrap items-start gap-3 rounded-lg border-l-4 p-3",
        hard ? "border-l-stamp" : "border-l-amber"
      )}
    >
      <div className="min-w-0 flex-1 text-[13.5px]">
        {hard ? (
          <>
            <b>AI hard cap reached:</b> £{spendGbp.toFixed(2)} of the £{hardCapGbp!.toFixed(2)} monthly
            cap. Light is not generating new drafts — each attempt refuses visibly with the cap named.
            Approved sends and template-path drafts continue; the approval gate is untouched.
          </>
        ) : (
          <>
            <b>AI soft cap crossed:</b> £{spendGbp.toFixed(2)} of the £{softCapGbp?.toFixed(2)} monthly
            soft cap. Nothing is blocked — this is the warning you asked for.
          </>
        )}
        <small className="mt-1 block font-mono text-[10px] tracking-[.04em] text-ink-faint uppercase">
          Monitor: monthly metered cost vs owner-set caps · enforced server-side in the drafting path
        </small>
      </div>
      {showBillingLink ? (
        <Link
          href="/billing"
          className="shrink-0 rounded-lg border border-rule bg-paper px-3 py-1.5 text-[12px] font-bold text-ink transition-colors hover:border-accent"
        >
          Billing &amp; usage
        </Link>
      ) : null}
    </div>
  );
}
