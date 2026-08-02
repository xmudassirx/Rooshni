"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, Check, Stamp } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { approveAction, rejectAction, type DecisionState } from "./actions";
import { STANDING_REASON } from "./standing-reason";

const initialState: DecisionState = { error: null };

export function DecisionControls({
  communicationId,
  preflightPass,
  blockedDetails,
  onEdit,
  returnTo,
}: {
  communicationId: string;
  preflightPass: boolean;
  blockedDetails: string[];
  /** Session 15 (signed amendment 2): edit-before-stamp — a stamp-authority
   * act; saving re-runs the pre-flight on the edited words. */
  onEdit?: () => void;
  /** Session 23 (WS1b): where a rejection returns the viewer — the thread
   * view passes its own path; the inbox omits it. Same act either way. */
  returnTo?: string;
}) {
  const [approveState, approve, approving] = useActionState(approveAction, initialState);
  const [rejectState, reject, rejecting] = useActionState(rejectAction, initialState);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  const router = useRouter();

  // Session 11 (founder-ruled): a stamped row never disappears instantly —
  // it shows its transient state, then leaves for History on the refresh.
  useEffect(() => {
    if (!approveState.stamped) return;
    const t = window.setTimeout(() => router.refresh(), 2200);
    return () => window.clearTimeout(t);
  }, [approveState.stamped, router]);

  if (approveState.stamped) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-ledger/40 bg-ledger/10 px-3 py-2 text-[13px] font-semibold text-ledger">
        <Check className="size-4" strokeWidth={3} /> Stamped — on The Record
        <span className="font-mono text-[10px] font-normal tracking-wide uppercase opacity-80">
          dispatching now · find it again under History
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {/* WS4 (Session 22): one-handed on a phone — the stamp spans the full
          width thumb-first, Edit and Reject share the row beneath; desktop
          keeps the inline row. Same controls, responsive placement only. */}
      <div className="flex flex-wrap items-center gap-2 max-[560px]:grid max-[560px]:grid-cols-2">
        {preflightPass ? (
          <form action={approve} className="max-[560px]:col-span-2">
            <input type="hidden" name="communicationId" value={communicationId} />
            <Button
              variant="approve"
              size="sm"
              disabled={approving || rejecting}
              className="max-[560px]:w-full"
            >
              <Stamp /> {approving ? "Stamping…" : "Approve"}
            </Button>
          </form>
        ) : (
          // The Approve control must be earned: pre-flight withholds the
          // stamp, so the button is not offered — not merely discouraged.
          <Button
            variant="default"
            size="sm"
            disabled
            className="border-stamp text-stamp max-[560px]:col-span-2 max-[560px]:w-full"
          >
            <Ban /> Blocked by pre-flight
          </Button>
        )}

        {onEdit ? (
          <Button size="sm" variant="ghost" disabled={approving || rejecting} onClick={onEdit}>
            Edit draft
          </Button>
        ) : null}

        <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
          <DialogTrigger asChild>
            <Button size="sm" disabled={approving || rejecting}>
              Reject
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Reject this draft</DialogTitle>
              <DialogDescription>
                The database will refuse a rejection without a reason. It is
                recorded on the row and the ledger, and returns the draft to
                the drafter&rsquo;s queue.
              </DialogDescription>
            </DialogHeader>
            <form
              action={reject}
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                if (!reason.trim()) e.preventDefault();
              }}
            >
              <input type="hidden" name="communicationId" value={communicationId} />
              {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
              {/* JUDGMENT: the Session 12 standing chip also serves single
                  rejection — the scope names the chip without confining it
                  to the bulk dialog, and the reason is the same act. */}
              <button
                type="button"
                onClick={() => setReason(STANDING_REASON)}
                className="self-start cursor-pointer rounded-full border border-rule bg-paper px-2.5 py-1 font-mono text-[10px] tracking-wide text-ink-soft uppercase transition-colors hover:border-accent hover:text-ink"
              >
                shadow mode — handled by existing pipeline
              </button>
              <Textarea
                name="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this draft not right? Light learns from this."
                autoFocus
              />
              {rejectState.error ? (
                <p className="text-[12.5px] text-stamp">{rejectState.error}</p>
              ) : null}
              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" size="sm">
                    Cancel
                  </Button>
                </DialogClose>
                <Button
                  variant="approve"
                  size="sm"
                  type="submit"
                  disabled={!reason.trim() || rejecting}
                >
                  {rejecting ? "Recording…" : "Reject with reason"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {!preflightPass && blockedDetails.length > 0 ? (
        <p className="text-[12.5px] text-stamp">
          {blockedDetails.join(" · ")} — fix the failure, then the stamp appears.
        </p>
      ) : null}
      {approveState.error ? (
        <p className="text-[12.5px] text-stamp">{approveState.error}</p>
      ) : null}
    </div>
  );
}
