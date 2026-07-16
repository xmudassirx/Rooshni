"use client";

import { useState } from "react";
import Link from "next/link";

import { formatWhen } from "@/lib/format";
import type { WorkflowDetail } from "@/lib/server/queries";
import {
  gateChip,
  kindGlyph,
  stepCondition,
  stepDetail,
  stepLabel,
  stepTimer,
} from "@/lib/workflow-language";
import { cn } from "@/lib/utils";

/*
 * view-wfview, master mockup v2: a read-only canvas GENERATED from workflow
 * data — trigger, then the steps in sort order, each node carrying its
 * timer, gate and any condition its config names. Drag-and-drop editing of
 * this same canvas is Phase 3; branch geometry beyond the data's `when`
 * conditions is not drawn, because it is not data.
 */

const TABS = ["Flow", "Settings", "Runs", "Execution log"] as const;

export function WorkflowDetailClient({ wf }: { wf: WorkflowDetail }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Flow");

  return (
    <>
      <div className="mb-3.5 flex flex-wrap items-center gap-1.5">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "rounded-2xl border px-3 py-1 font-mono text-[11px] font-semibold tracking-wide uppercase",
              tab === t ? "border-ink bg-ink text-paper" : "border-rule bg-panel text-ink-soft"
            )}
          >
            {t}
            {t === "Runs" ? ` (${wf.runs.length})` : ""}
          </button>
        ))}
      </div>

      {tab === "Flow" ? (
        <div
          className="glass rounded-xl px-3 py-6"
          style={{
            backgroundImage: "radial-gradient(circle, rgba(32,43,56,.1) 1px, transparent 1px)",
            backgroundSize: "18px 18px",
          }}
        >
          <div className="mx-auto flex max-w-[420px] flex-col items-center">
            <div className="glass flex w-full cursor-default items-center gap-2.5 rounded-lg border-2 border-ink px-3 py-2.5">
              <span className="flex size-6.5 shrink-0 items-center justify-center rounded-md bg-ink text-[13px] text-white">
                ⚡
              </span>
              <span className="flex-1 text-[12.5px] font-semibold">
                {typeof wf.trigger.action === "string" ? wf.trigger.action : "Trigger"}
                <small className="mt-px block font-mono text-[9.5px] font-medium tracking-wide text-ink-faint uppercase">
                  Trigger
                  {typeof wf.trigger.source === "string" ? ` · source: ${wf.trigger.source}` : ""}
                </small>
              </span>
            </div>
            {wf.steps.map((step) => {
              const glyph = kindGlyph(step.kind);
              const gate = gateChip(step);
              const condition = stepCondition(step);
              const detail = stepDetail(step);
              return (
                <div key={step.id} className="flex w-full flex-col items-center">
                  <div className="relative h-5.5 w-0.5 bg-rule" />
                  {condition ? (
                    <span className="mb-1.5 rounded-xl border border-rule bg-paper-deep px-2.5 py-0.5 font-mono text-[9.5px] tracking-wide text-ink-soft uppercase">
                      when {condition}
                    </span>
                  ) : null}
                  <div className="glass flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5">
                    <span
                      className={cn(
                        "flex size-6.5 shrink-0 items-center justify-center rounded-md text-[13px]",
                        glyph.className
                      )}
                    >
                      {glyph.glyph}
                    </span>
                    <span className="flex-1 text-[12.5px] font-semibold">
                      {stepLabel(step)}
                      <small className="mt-px block font-mono text-[9.5px] font-medium tracking-wide text-ink-faint uppercase">
                        {stepTimer(step)} · {gate.label}
                        {detail ? ` · ${detail}` : ""}
                      </small>
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {tab === "Settings" ? (
        <div className="glass overflow-hidden rounded-xl">
          <h2 className="border-b border-rule bg-paper px-4 py-3 font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-soft uppercase">
            Trigger &amp; configuration — data, changed only through a stamp
          </h2>
          <div className="px-4 py-3.5">
            <pre className="overflow-x-auto rounded-lg border border-rule bg-paper p-3.5 font-mono text-[11.5px] text-ink">
              {JSON.stringify(wf.trigger, null, 2)}
            </pre>
            <p className="mt-3 text-[13px] text-ink-soft">
              Business hours, quiet hours and per-step templates configure here
              once their session lands — every change a Level 3 configuration
              change through your Approval Inbox.
            </p>
          </div>
        </div>
      ) : null}

      {tab === "Runs" ? (
        <div className="glass overflow-hidden rounded-xl">
          <h2 className="border-b border-rule bg-paper px-4 py-3 font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-soft uppercase">
            Runs — a view over workflow_runs, every enquiry currently inside
          </h2>
          {wf.runs.length ? (
            wf.runs.map((run) => (
              <Link
                key={run.id}
                href={`/enquiries/${run.engagementId}`}
                className="grid grid-cols-[1fr_130px_150px_170px] items-baseline gap-2.5 border-b border-paper-deep px-4 py-2.5 text-[12.5px] last:border-b-0 hover:bg-paper max-[760px]:grid-cols-[1fr_110px]"
              >
                <span className="font-semibold">{run.engagementTitle}</span>
                <span
                  className={cn(
                    "w-fit rounded px-1.5 py-0.5 font-mono text-[9.5px] font-semibold tracking-wide uppercase",
                    run.status === "completed"
                      ? "bg-ledger-tint text-ledger"
                      : run.status === "blocked"
                        ? "bg-stamp-tint text-stamp"
                        : "bg-accent-tint text-accent"
                  )}
                >
                  {run.status}
                </span>
                <span className="font-mono text-[10.5px] text-ink-faint max-[760px]:hidden">
                  {run.currentStepKey ? `at ${run.currentStepKey.replace(/_/g, " ")}` : "—"}
                </span>
                <span className="font-mono text-[10.5px] text-ink-faint max-[760px]:hidden">
                  started {formatWhen(run.startedAt)}
                </span>
              </Link>
            ))
          ) : (
            <p className="px-4 py-6 text-center text-[13px] text-ink-soft">
              No runs yet — a run starts the moment the trigger fires.
            </p>
          )}
        </div>
      ) : null}

      {tab === "Execution log" ? (
        <div className="glass overflow-hidden rounded-xl">
          <h2 className="border-b border-rule bg-paper px-4 py-3 font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-soft uppercase">
            Execution log — every step of every run; nothing is ever lost
          </h2>
          {wf.stepRuns.length ? (
            wf.stepRuns.map((sr) => (
              <div
                key={sr.id}
                className="grid grid-cols-[170px_1fr_130px] items-baseline gap-2.5 border-b border-paper-deep px-4 py-2 text-[12.5px] last:border-b-0 max-[640px]:grid-cols-[1fr_110px]"
              >
                <span className="font-mono text-[10.5px] text-ink-faint max-[640px]:hidden">
                  {formatWhen(sr.finishedAt ?? sr.startedAt ?? sr.scheduledFor)}
                </span>
                <span>{sr.stepKey.replace(/_/g, " ")}</span>
                <span
                  className={cn(
                    "w-fit rounded px-1.5 py-0.5 font-mono text-[9.5px] font-semibold tracking-wide uppercase",
                    sr.status === "completed"
                      ? "bg-ledger-tint text-ledger"
                      : sr.status === "awaiting_approval"
                        ? "light-chip"
                        : sr.status === "failed"
                          ? "bg-stamp-tint text-stamp"
                          : "bg-paper-deep text-ink-soft"
                  )}
                >
                  {sr.status.replace(/_/g, " ")}
                </span>
              </div>
            ))
          ) : (
            <p className="px-4 py-6 text-center text-[13px] text-ink-soft">
              No step executions yet.
            </p>
          )}
        </div>
      ) : null}

      <p className="mt-3 font-mono text-xs text-ink-faint">
        TAP NOTHING TO EDIT — THIS CANVAS IS GENERATED FROM THE WORKFLOW DATA, NOTHING TO
        KEEP IN SYNC · TIMERS ARE PROVISIONAL PENDING THE LEAD LOG · DRAG-AND-DROP EDITING
        ARRIVES IN PHASE 3 — UNTIL THEN, EDITS GO THROUGH FORMS AND LIGHT PROPOSALS.
      </p>
    </>
  );
}
