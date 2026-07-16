import Link from "next/link";

import { PageHead } from "@/components/shell/page-head";
import { HonestButton } from "@/components/ui/honest-button";
import { getWorkflows } from "@/lib/server/queries";
import {
  gateChip,
  stepLabel,
  stepTimer,
  workflowTitle,
} from "@/lib/workflow-language";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function AutomationPage() {
  const workflows = await getWorkflows();

  return (
    <>
      <PageHead
        title="Automation"
        sub="Workflows are data — readable, toggleable, and only ever changed through your stamp"
        actions={
          <HonestButton
            variant="primary"
            notice="New workflows are described in plain English and land in your Approval Inbox as Level 3 config changes — the visual builder arrives in Phase 3."
          >
            + New workflow
          </HonestButton>
        }
      />

      {workflows.length ? (
        workflows.map((wf) => (
          <Link
            key={wf.id}
            href={`/automation/${wf.id}`}
            className="glass mb-4 block overflow-hidden rounded-xl transition-colors hover:border-accent"
          >
            <h2 className="border-b border-rule bg-paper px-4 py-3 font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-soft uppercase">
              {workflowTitle(wf.key)} · v{wf.version} ·{" "}
              <span className={wf.status === "active" ? "text-ledger" : "text-ink-faint"}>
                {wf.status}
              </span>{" "}
              · {wf.activeRuns} enquir{wf.activeRuns === 1 ? "y" : "ies"} currently inside ·{" "}
              <span className="text-accent">Tap to open the flow →</span>
            </h2>
            <div className="px-4 pt-2.5 pb-4">
              <p className="mb-3 text-[13px] text-ink-soft">{wf.description}</p>
              <div className="grid grid-cols-[1fr_140px_90px] gap-2.5 border-b border-rule py-2 font-mono text-[9.5px] font-semibold tracking-[.12em] text-ink-faint uppercase max-[640px]:grid-cols-[1fr_100px_70px]">
                <span>Step</span>
                <span>Timer</span>
                <span>Gate</span>
              </div>
              {wf.steps.map((step, i) => {
                const gate = gateChip(step);
                return (
                  <div
                    key={step.id}
                    className="grid grid-cols-[1fr_140px_90px] items-center gap-2.5 border-b border-dashed border-rule py-2 text-[13px] last:border-b-0 max-[640px]:grid-cols-[1fr_100px_70px]"
                  >
                    <span>
                      {i + 1} · {stepLabel(step)}
                    </span>
                    <span className="font-mono text-[11px] text-amber">{stepTimer(step)}</span>
                    <span
                      className={cn(
                        "w-fit rounded px-1.5 py-0.5 font-mono text-[9.5px] font-semibold tracking-wide uppercase",
                        gate.stamped
                          ? "bg-ink text-paper"
                          : "border border-rule bg-paper-deep text-ink-soft"
                      )}
                    >
                      {gate.label}
                    </span>
                  </div>
                );
              })}
              <p className="mt-3 font-mono text-[10.5px] text-ink-faint uppercase">
                A reply at any point cancels queued touches · junk is proposed, never
                auto-declared, in Phase 1 · every timer is data, scaled by TIME_SCALE
              </p>
            </div>
          </Link>
        ))
      ) : (
        <div className="glass rounded-2xl border-dashed p-9 text-center">
          <h2 className="mb-2 font-display text-xl font-extrabold">No workflows yet</h2>
          <p className="mx-auto max-w-[42ch] text-sm text-ink-soft">
            Workflows are rows in workflow_definitions — the first arrives with
            its approval, in plain English, through your inbox.
          </p>
        </div>
      )}

      {/* Light's proposals — nothing proposed until Light can observe patterns. */}
      <div className="light-panel mt-4 rounded-xl px-4 py-3.5">
        <h2 className="light-head mb-2 font-mono text-[10.5px] font-semibold tracking-[.14em] uppercase">
          ✦ Proposed by Light — awaiting your stamp
        </h2>
        <p className="text-[13px] text-ink-soft">
          Nothing proposed. When Light notices a repeated manual pattern it will
          propose a workflow here in plain English — and the proposal still
          enters through your Approval Inbox, like every configuration change.
        </p>
      </div>

      <p className="mt-3 font-mono text-xs text-ink-faint">
        CREATING OR EDITING A WORKFLOW IS A LEVEL 3 CONFIGURATION CHANGE — THE MACHINE GROWS
        NEW HABITS ONLY ON THE RECORD. FULL VISUAL BUILDER: PHASE 3.
      </p>
    </>
  );
}
