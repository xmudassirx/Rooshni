"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  cancelTaskAction,
  declineTaskCancellationAction,
  type TaskActionState,
} from "../tasks/actions";

/*
 * Session 23 (WS4d) — the manager's decision on a member's cancellation
 * request. Approving cancels the task through the SAME cancelTaskAction the
 * Tasks surface uses (terminal per the 0037 trigger, evented, the approved
 * request recorded in the event payload); declining clears the request with
 * a stated reason, evented. A non-manager sees the facts and no controls
 * (decision 116: no control that cannot act).
 */

const INITIAL: TaskActionState = { error: null };

export function TaskCancellationControls({
  taskId,
  isManager,
}: {
  taskId: string;
  isManager: boolean;
}) {
  const router = useRouter();
  const [cancelState, cancelFormAction, cancelling] = useActionState(cancelTaskAction, INITIAL);
  const [declineState, declineFormAction, declining] = useActionState(
    declineTaskCancellationAction,
    INITIAL
  );
  const [declineOpen, setDeclineOpen] = useState(false);
  const [reason, setReason] = useState("");
  const settled =
    (cancelState.error === null && cancelState !== INITIAL && !cancelling) ||
    (declineState.error === null && declineState !== INITIAL && !declining);

  useEffect(() => {
    if (settled) router.refresh();
  }, [settled, router]);

  if (!isManager) {
    return (
      <p className="text-[12.5px] text-ink-soft">
        Deciding a cancellation request is a manager&rsquo;s act (owner, or Team &amp; Access
        authority) — the facts above are the request as recorded.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 max-[560px]:grid max-[560px]:grid-cols-2">
        <form action={cancelFormAction} className="max-[560px]:col-span-2">
          <input type="hidden" name="id" value={taskId} />
          <Button variant="approve" size="sm" disabled={cancelling || declining} className="max-[560px]:w-full">
            <Check /> {cancelling ? "Cancelling…" : "Approve — cancel the task"}
          </Button>
        </form>
        {declineOpen ? null : (
          <Button size="sm" disabled={cancelling || declining} onClick={() => setDeclineOpen(true)}>
            Decline request…
          </Button>
        )}
      </div>
      {declineOpen ? (
        <form action={declineFormAction} className="flex flex-col gap-2">
          <input type="hidden" name="id" value={taskId} />
          <Textarea
            name="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why does this task stay open? The requester reads this on The Record."
            autoFocus
          />
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" type="button" onClick={() => setDeclineOpen(false)}>
              Back
            </Button>
            <Button variant="approve" size="sm" type="submit" disabled={!reason.trim() || declining}>
              {declining ? "Recording…" : "Decline with reason"}
            </Button>
          </div>
        </form>
      ) : null}
      {cancelState.error ? <p className="text-[12.5px] text-stamp">{cancelState.error}</p> : null}
      {declineState.error ? <p className="text-[12.5px] text-stamp">{declineState.error}</p> : null}
      <p className="font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">
        Approving cancels the task — terminal, evented, never deleted. Declining clears the
        request with your reason on The Record.
      </p>
    </div>
  );
}
