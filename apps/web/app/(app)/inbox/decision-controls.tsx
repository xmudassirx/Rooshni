"use client";

import { useActionState, useState } from "react";
import { Ban, Stamp } from "lucide-react";

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

const initialState: DecisionState = { error: null };

export function DecisionControls({
  communicationId,
  preflightPass,
  blockedDetails,
}: {
  communicationId: string;
  preflightPass: boolean;
  blockedDetails: string[];
}) {
  const [approveState, approve, approving] = useActionState(approveAction, initialState);
  const [rejectState, reject, rejecting] = useActionState(rejectAction, initialState);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {preflightPass ? (
          <form action={approve}>
            <input type="hidden" name="communicationId" value={communicationId} />
            <Button variant="approve" size="sm" disabled={approving || rejecting}>
              <Stamp /> {approving ? "Stamping…" : "Approve"}
            </Button>
          </form>
        ) : (
          // The Approve control must be earned: pre-flight withholds the
          // stamp, so the button is not offered — not merely discouraged.
          <Button variant="default" size="sm" disabled className="border-stamp text-stamp">
            <Ban /> Blocked by pre-flight
          </Button>
        )}

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
