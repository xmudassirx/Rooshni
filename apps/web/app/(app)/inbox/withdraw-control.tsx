"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Undo2 } from "lucide-react";

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
import { withdrawDefinitionAction, type WithdrawDefinitionState } from "./actions";

const initialState: WithdrawDefinitionState = { error: null };

/**
 * Session 21 (founder-ruled) — the ONE control a pending workflow definition
 * offers, and only to the owner: Withdraw, with a required reason. Approve is
 * deliberately absent until the definition-approval pipeline's own session
 * (decision 116: no control that cannot act). The withdrawal is terminal,
 * recorded on the row and The Record, and visible in History.
 */
export function WithdrawControl({ definitionId }: { definitionId: string }) {
  const [state, submit, submitting] = useActionState(withdrawDefinitionAction, initialState);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const router = useRouter();

  // The Session 11 stamped-state rhythm: the row never vanishes silently —
  // it shows what happened, then leaves for History on the refresh.
  useEffect(() => {
    if (!state.withdrawn) return;
    setOpen(false);
    const t = window.setTimeout(() => router.refresh(), 2200);
    return () => window.clearTimeout(t);
  }, [state.withdrawn, router]);

  if (state.withdrawn) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-rule bg-paper-deep px-3 py-2 text-[13px] font-semibold text-ink-soft">
        <Undo2 className="size-4" strokeWidth={2.5} /> Withdrawn — on The Record
        <span className="font-mono text-[10px] font-normal tracking-wide uppercase opacity-80">
          terminal, never deleted · find it again under History
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" disabled={submitting}>
              <Undo2 /> Withdraw
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Withdraw this proposed workflow</DialogTitle>
              <DialogDescription>
                The database will refuse a withdrawal without a reason. It is
                recorded on the row and the ledger. Withdrawn is terminal: the
                proposal never activates, never runs, and is never deleted.
              </DialogDescription>
            </DialogHeader>
            <form
              action={submit}
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                if (!reason.trim()) e.preventDefault();
              }}
            >
              <input type="hidden" name="definitionId" value={definitionId} />
              <Textarea
                name="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this proposal being withdrawn?"
                autoFocus
              />
              {state.error ? (
                <p className="text-[12.5px] text-stamp">{state.error}</p>
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
                  disabled={!reason.trim() || submitting}
                >
                  {submitting ? "Recording…" : "Withdraw with reason"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
      {state.error && !open ? (
        <p className="text-[12.5px] text-stamp">{state.error}</p>
      ) : null}
    </div>
  );
}
