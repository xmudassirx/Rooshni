"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { setAiBudgetAction, type AiBudgetActionState } from "./actions";

/*
 * Session 22 (WS2, ruling 2b) — the caps, set by the owner from the page
 * that shows the spend they bound. Blank = no cap. The database of record is
 * businesses.settings.ai_budget; enforcement lives in the drafting path.
 */

const INITIAL: AiBudgetActionState = { error: null };

export function CapsForm({
  softCapGbp,
  hardCapGbp,
  isOwner,
}: {
  softCapGbp: number | null;
  hardCapGbp: number | null;
  isOwner: boolean;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(setAiBudgetAction, INITIAL);

  useEffect(() => {
    if (state.saved) router.refresh();
  }, [state.saved, router]);

  return (
    <form action={formAction} className="px-5 py-4">
      <div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
        <label className="block">
          <span className="font-mono text-[9.5px] tracking-[.12em] text-ink-faint uppercase">
            Soft cap · warn (£ / month)
          </span>
          <input
            type="number"
            name="soft_cap"
            step="0.01"
            min="0"
            defaultValue={softCapGbp ?? ""}
            placeholder="no cap"
            disabled={pending || !isOwner}
            className="mt-0.5 w-full rounded-lg border border-rule bg-paper-deep px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
          />
        </label>
        <label className="block">
          <span className="font-mono text-[9.5px] tracking-[.12em] text-ink-faint uppercase">
            Hard cap · stop (£ / month)
          </span>
          <input
            type="number"
            name="hard_cap"
            step="0.01"
            min="0"
            defaultValue={hardCapGbp ?? ""}
            placeholder="no cap"
            disabled={pending || !isOwner}
            className="mt-0.5 w-full rounded-lg border border-rule bg-paper-deep px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
          />
        </label>
      </div>
      <div className="mt-2.5 flex items-center gap-3">
        <button
          type="submit"
          disabled={pending || !isOwner}
          className="rounded-lg border border-accent/50 bg-accent/10 px-3 py-1.5 text-[12px] font-bold text-accent transition-colors hover:bg-accent/15 disabled:cursor-default disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save caps"}
        </button>
        <span className="text-[11px] leading-relaxed text-ink-faint">
          Soft cap crossed = a visible warning, nothing blocked. Hard cap crossed = Light stops
          generating with the cap named; sends that need no generation continue.
        </span>
      </div>
      {!isOwner ? (
        <p className="mt-1.5 text-[11px] text-ink-faint">
          The caps are the owner&apos;s pen — shown here so the state is one truth for everyone.
        </p>
      ) : null}
      {state.error ? <p className="mt-1.5 text-[12px] text-stamp">{state.error}</p> : null}
    </form>
  );
}
