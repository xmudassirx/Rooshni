"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";

import { retryFailedSendAction, type RetrySendState } from "./actions";

/*
 * Defect-pair hotfix (2 Aug 2026, item 2) — the ONE Retry control every
 * surface renders on a stamped-but-failed message (thread bubble, inbox
 * History, enquiry timeline). Same body, same stamp: the 0040 door
 * re-earns the pre-flight inside the transition and the ledger records the
 * human decision; this face only asks. Rendered only for stamp-holders and
 * only while the row is still failed (decision 116: no control that cannot
 * act) — the door re-enforces both regardless.
 */

const INITIAL: RetrySendState = { error: null };

export function RetrySendControl({ communicationId }: { communicationId: string }) {
  const [state, retry, retrying] = useActionState(retryFailedSendAction, INITIAL);
  const router = useRouter();

  useEffect(() => {
    if (!state.retried) return;
    const t = window.setTimeout(() => router.refresh(), 900);
    return () => window.clearTimeout(t);
  }, [state.retried, router]);

  if (state.retried) {
    return (
      <span className="font-mono text-[9.5px] font-semibold tracking-wide text-ledger uppercase">
        retrying — same words, same stamp
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <form action={retry} className="inline">
        <input type="hidden" name="communicationId" value={communicationId} />
        <button
          type="submit"
          disabled={retrying}
          className="cursor-pointer rounded-md border border-stamp/50 bg-stamp/10 px-2 py-0.5 font-mono text-[9.5px] font-semibold tracking-wide text-stamp uppercase hover:bg-stamp/20 disabled:opacity-60"
        >
          {retrying ? "retrying…" : "↻ Retry send"}
        </button>
      </form>
      {state.error ? <span className="text-[11px] text-stamp">{state.error}</span> : null}
    </span>
  );
}
