"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Stamp } from "lucide-react";

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
import {
  approveCorrectionAction,
  rejectCorrectionAction,
  type CorrectionDecisionState,
} from "./actions";

const initialState: CorrectionDecisionState = { error: null };

/**
 * Session 32 (D181a) — the stamp on a ripple-sweep correction. Approving
 * APPLIES the change (a template re-issue or a knowledge-entry update);
 * rejecting records its reason and touches nothing. Nothing auto-applies.
 */
export function CorrectionControls({ correctionId }: { correctionId: string }) {
  const [applyState, apply, applying] = useActionState(approveCorrectionAction, initialState);
  const [rejectState, reject, rejecting] = useActionState(rejectCorrectionAction, initialState);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  const router = useRouter();

  const decided = applyState.decided ?? rejectState.decided;
  useEffect(() => {
    if (!decided) return;
    const t = window.setTimeout(() => router.refresh(), 2200);
    return () => window.clearTimeout(t);
  }, [decided, router]);

  if (decided === "applied") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-ledger/40 bg-ledger/10 px-3 py-2 text-[13px] font-semibold text-ledger">
        <Check className="size-4" strokeWidth={3} /> Applied — on The Record
        <span className="font-mono text-[10px] font-normal tracking-wide uppercase opacity-80">
          the surface now carries the new value
        </span>
      </div>
    );
  }
  if (decided === "rejected") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-stamp/40 bg-stamp/10 px-3 py-2 text-[13px] font-semibold text-stamp">
        Declined — the surface stands untouched
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 max-[560px]:grid max-[560px]:grid-cols-2">
        <form action={apply} className="max-[560px]:col-span-2">
          <input type="hidden" name="correctionId" value={correctionId} />
          <Button variant="approve" size="sm" disabled={applying || rejecting} className="max-[560px]:w-full">
            <Stamp /> {applying ? "Applying…" : "Approve — apply the correction"}
          </Button>
        </form>
        <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
          <DialogTrigger asChild>
            <Button size="sm" disabled={applying || rejecting}>
              Reject
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Decline this correction</DialogTitle>
              <DialogDescription>
                A reason is required — it is recorded on the correction and the
                ledger. The surface keeps its current wording.
              </DialogDescription>
            </DialogHeader>
            <form
              action={reject}
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                if (!reason.trim()) e.preventDefault();
              }}
            >
              <input type="hidden" name="correctionId" value={correctionId} />
              <Textarea
                name="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why should this surface keep its current wording?"
                autoFocus
              />
              {rejectState.error ? <p className="text-[12.5px] text-stamp">{rejectState.error}</p> : null}
              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" size="sm">
                    Cancel
                  </Button>
                </DialogClose>
                <Button variant="approve" size="sm" type="submit" disabled={!reason.trim() || rejecting}>
                  {rejecting ? "Recording…" : "Reject with reason"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
      {applyState.error ? <p className="text-[12.5px] text-stamp">{applyState.error}</p> : null}
    </div>
  );
}
