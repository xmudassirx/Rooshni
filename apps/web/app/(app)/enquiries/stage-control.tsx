"use client";

import { useActionState, useState } from "react";

import { moveStageAction, type MoveStageState } from "./actions";

/*
 * Session 30 (177f): the human stage move — a dropdown of the installed
 * template's stages PLUS its terminal states (disqualified with reason among
 * them), open to any team member with enquiry access (the D161c
 * route-control precedent: the 0015/0016 doors are the enforcement; this is
 * only the pen). The act is evented with the optional reason; choosing the
 * disqualified terminal names its consequence before the move — the live
 * workflow run is cancelled (177d), drafts stop being generated.
 */
export function StageMoveControl({
  engagementId,
  currentStageId,
  stages,
}: {
  engagementId: string;
  currentStageId: string | null;
  stages: Array<{
    id: string;
    label: string;
    isTerminal: boolean;
    terminalOutcome: string | null;
  }>;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [state, submit, submitting] = useActionState(moveStageAction, {
    error: null,
  } as MoveStageState);

  if (stages.length === 0) return null;
  const targetStage = stages.find((s) => s.id === target) ?? null;
  const disqualifies = targetStage?.terminalOutcome === "disqualified";

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="cursor-pointer font-mono text-[10px] font-semibold tracking-wide text-accent uppercase hover:underline"
      >
        move stage
      </button>
    );
  }
  return (
    <form action={submit} className="mt-1.5 flex flex-col gap-1.5">
      <input type="hidden" name="engagement_id" value={engagementId} />
      <select
        name="to_stage_id"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        required
        className="rounded-md border border-rule bg-paper px-2 py-1.5 text-[12.5px]"
      >
        <option value="" disabled>
          Choose a stage…
        </option>
        {stages.map((s) => (
          <option key={s.id} value={s.id} disabled={s.id === currentStageId}>
            {s.label}
            {s.id === currentStageId ? " (current)" : s.isTerminal ? " (closes the enquiry)" : ""}
          </option>
        ))}
      </select>
      <input
        name="reason"
        placeholder="Reason (optional) — recorded on The Record"
        className="rounded-md border border-rule bg-paper px-2 py-1.5 text-[12px]"
      />
      {disqualifies ? (
        <span className="text-[11.5px] text-ink-soft">
          Disqualifying cancels this enquiry&rsquo;s live workflow run — Light stops drafting for
          it. The history stands untouched.
        </span>
      ) : null}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={submitting || !target}
          className="cursor-pointer rounded-md bg-accent px-2.5 py-1 font-mono text-[10px] font-semibold tracking-wide text-white uppercase disabled:opacity-60"
        >
          {submitting ? "moving…" : "move stage"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="cursor-pointer font-mono text-[10px] tracking-wide text-ink-soft uppercase hover:underline"
        >
          cancel
        </button>
      </div>
      {state.error ? <span className="text-[11.5px] text-stamp">{state.error}</span> : null}
      {state.saved ? (
        <span className="font-mono text-[10px] tracking-wide text-ledger uppercase">
          stage moved — evented on The Record
          {state.cancelledRuns
            ? ` · ${state.cancelledRuns} workflow ${state.cancelledRuns === 1 ? "run" : "runs"} cancelled`
            : ""}
        </span>
      ) : null}
    </form>
  );
}
