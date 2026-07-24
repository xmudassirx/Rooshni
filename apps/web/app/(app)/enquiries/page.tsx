import Link from "next/link";

import { EmptyState } from "@/components/shell/empty-state";
import { PageHead } from "@/components/shell/page-head";
import { Badge } from "@/components/ui/badge";
import { HonestButton } from "@/components/ui/honest-button";
import { durationSince } from "@/lib/format";
import { getPipeline, type PipelineCard } from "@/lib/server/queries";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

function sourceLabel(source: string | null): string | null {
  if (!source) return null;
  return source === "meta" ? "Meta" : source.charAt(0).toUpperCase() + source.slice(1);
}

function Card({ card }: { card: PipelineCard }) {
  const inStage = durationSince(card.stageEnteredAt);
  // Past a day in one stage is worth an amber nudge on the board.
  const warn = Date.now() - new Date(card.stageEnteredAt).getTime() > 24 * 60 * 60 * 1000;
  const source = sourceLabel(card.source);

  return (
    <Link
      href={`/enquiries/${card.engagementId}`}
      className="glass block w-full rounded-lg p-3 text-left transition-colors hover:border-accent"
    >
      <div className="text-sm font-bold">{card.name}</div>
      <div className="mt-px mb-1.5 font-mono text-[11px] font-semibold text-accent">
        {card.visaRoute ?? "Route not yet classified"}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {source ? <Badge variant="source">{source}</Badge> : null}
        <Badge variant={warn ? "warn" : "time"}>{inStage} in stage</Badge>
        {card.pendingApprovals > 0 ? (
          <Badge variant="gold">
            {card.pendingApprovals} pending approval{card.pendingApprovals > 1 ? "s" : ""}
          </Badge>
        ) : null}
      </div>
      {card.nextAction ? (
        <div className="mt-2 flex items-center gap-1.5 border-t border-dashed border-rule pt-1.5 text-[11.5px] text-ink-soft">
          {card.nextAction.byLight ? (
            <span className="light-spark shrink-0 text-[11px] leading-none">✦</span>
          ) : null}
          <span className="truncate">{card.nextAction.text}</span>
        </div>
      ) : null}
    </Link>
  );
}

export default async function EnquiriesPage() {
  const stages = await getPipeline();

  // Day one, before the first enquiry: the true empty state (Session 11
  // mockup). The stage line renders FROM the installed template's own
  // stage set — never a hardcoded vocabulary.
  if (stages.every((s) => s.cards.length === 0)) {
    const stageLine = [
      ...stages.filter((s) => !s.isTerminal).map((s) => s.label),
      "Closed",
    ].join(" → ");
    return (
      <>
        <PageHead
          title="Enquiries"
          sub="Every enquiry moves left to right — one stage vocabulary, every surface"
        />
        <EmptyState
          icon="☰"
          title="Your pipeline, before its first enquiry"
          action={
            <HonestButton
              size="sm"
              variant="default"
              notice="Manual entry always works — Light is the fast path, never the only path. The add-by-hand form arrives with its session."
            >
              + Add an enquiry by hand
            </HonestButton>
          }
        >
          <p>
            {stageLine}. The moment a lead form, WhatsApp message or email
            arrives, it lands here as a card — captured by Light, moved only
            through gates.
          </p>
          <p>
            Connect Meta Lead Forms and WhatsApp in First Light and this board
            starts filling itself.
          </p>
        </EmptyState>
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Enquiries"
        sub="Lead-to-consultation pipeline · tap any card for the enquiry's full story — stage moves arrive with their controls"
      />
      <div className="flex snap-x snap-proximity gap-3 overflow-x-auto px-0.5 pt-2 pb-4">
        {/* Fluid shell: columns keep their minimum but grow into wide
            viewports — containers stretch, prose doesn't. */}
        {stages.map((stage) => (
          <div key={stage.id} className="min-w-62 flex-1 shrink-0 snap-start">
            <div
              className={cn(
                "relative flex items-center gap-2 rounded-t-lg px-3 py-1.5 font-mono text-[11px] font-semibold tracking-wide text-paper uppercase",
                // v3 splits Instructed from the Won terminal — green stays
                // done-semantics only (decision 61).
                stage.key === "won" ? "bg-ledger" : "bg-ink"
              )}
            >
              {stage.label}
              {stage.key === "won" ? " ✓" : ""}
              <span className="ml-auto rounded-lg bg-paper/20 px-1.5 text-[10.5px]">
                {stage.cards.length}
              </span>
            </div>
            <div className="flex min-h-30 flex-col gap-2 rounded-b-xl border border-t-0 border-rule bg-paper-deep p-2">
              {stage.cards.map((card) => (
                <Card key={card.engagementId} card={card} />
              ))}
              {stage.cards.length === 0 ? (
                <div className="py-6 text-center font-mono text-[10px] tracking-wide text-ink-faint uppercase">
                  Empty
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      <p className="font-mono text-xs text-ink-faint">
        Every card is live from the database — the same rows the Approval Inbox
        and the Record read.
      </p>
    </>
  );
}
