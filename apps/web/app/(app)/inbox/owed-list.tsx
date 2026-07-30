"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { bulkRejectAction, type BulkRejectState } from "./actions";
import { InboxCard, type InboxCardProps } from "./inbox-card";
import { STANDING_REASON } from "./standing-reason";

const initialState: BulkRejectState = { error: null };

/**
 * Session 12: selection mode over the stamps-owed cards, feeding the one
 * bulk act that exists — Reject. Approve has no bulk path here or anywhere:
 * selection never attaches to the stamp, only to the refusal.
 */
export function OwedList({ cards }: { cards: InboxCardProps[] }) {
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<BulkRejectState | null>(null);
  const [state, submit, submitting] = useActionState(bulkRejectAction, initialState);
  const router = useRouter();
  const handled = useRef<BulkRejectState | null>(null);

  // JUDGMENT: only communications are selectable — content/task items have
  // no rejection pipeline yet (their cards already say so), and offering a
  // checkbox that cannot act would be an unearned control.
  const selectableIds = cards
    .filter((c) => c.itemType === "communication")
    .map((c) => c.itemId);
  const allSelected =
    selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exitSelection() {
    setSelecting(false);
    setSelected(new Set());
  }

  // The refusals landed: close the dialog, show the honest tally, then let
  // the refresh carry the rows out of the view (Session 11's stamped-state
  // rhythm — nothing vanishes without saying why).
  useEffect(() => {
    if (state === initialState || state === handled.current) return;
    if (state.rejected === undefined && state.error === null) return;
    handled.current = state;
    if (state.rejected !== undefined && state.rejected > 0) {
      setBulkOpen(false);
      setReason("");
      exitSelection();
      setNotice(state);
      const t = window.setTimeout(() => {
        setNotice(null);
        router.refresh();
      }, 2600);
      return () => window.clearTimeout(t);
    }
  }, [state, router]);

  function BoxIcon({ on }: { on: boolean }) {
    return (
      <span
        aria-hidden
        className={cn(
          "flex size-[18px] shrink-0 items-center justify-center rounded border transition-colors",
          on ? "border-accent bg-accent text-white" : "border-rule bg-paper"
        )}
      >
        {on ? <Check className="size-3" strokeWidth={3.5} /> : null}
      </span>
    );
  }

  return (
    <div className="flex max-w-[860px] flex-col gap-3">
      {notice ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-stamp/40 bg-stamp/10 px-3 py-2 text-[13px] font-semibold text-stamp">
          <X className="size-4" strokeWidth={3} />
          {notice.rejected} rejected
          {notice.failed ? ` · ${notice.failed} failed` : ""}
          <span className="font-mono text-[10px] font-normal tracking-wide uppercase opacity-80">
            every refusal is its own entry on The Record · drafts return to
            Light&rsquo;s queue
          </span>
        </div>
      ) : null}
      {notice?.error ? (
        <p className="text-[12.5px] text-stamp">{notice.error}</p>
      ) : null}

      {selectableIds.length > 0 ? (
        selecting ? (
          <div className="glass flex flex-wrap items-center gap-3 rounded-xl px-4 py-2.5">
            <button
              type="button"
              role="checkbox"
              aria-checked={allSelected}
              onClick={() =>
                setSelected(allSelected ? new Set() : new Set(selectableIds))
              }
              className="flex cursor-pointer items-center gap-2 text-[12.5px] font-medium"
            >
              <BoxIcon on={allSelected} />
              Select all visible ({selectableIds.length})
            </button>
            <span className="font-mono text-[10px] tracking-wide text-ink-faint uppercase">
              {selected.size} selected
            </span>
            <span className="ml-auto font-mono text-[10px] tracking-wide text-ink-faint uppercase">
              rejection only — approval is never bulk; every stamp is individual
            </span>
            <Button
              variant="approve"
              size="sm"
              disabled={selected.size === 0 || submitting}
              onClick={() => setBulkOpen(true)}
            >
              Reject selected…
            </Button>
            <Button variant="ghost" size="sm" onClick={exitSelection}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-end">
            <Button size="sm" onClick={() => setSelecting(true)}>
              Select for rejection
            </Button>
          </div>
        )
      ) : null}

      {cards.map((card) => (
        <InboxCard
          key={`${card.itemType}-${card.itemId}`}
          {...card}
          selection={
            selecting && card.itemType === "communication"
              ? {
                  selected: selected.has(card.itemId),
                  onToggle: () => toggle(card.itemId),
                }
              : null
          }
        />
      ))}

      <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Reject {selected.size} draft{selected.size === 1 ? "" : "s"}
            </DialogTitle>
            <DialogDescription>
              One shared reason, applied to every selected draft — but each
              rejection lands as its own refusal on its row and The Record,
              exactly as if rejected alone, and returns that draft to
              Light&rsquo;s queue.
            </DialogDescription>
          </DialogHeader>
          <form
            action={submit}
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              if (!reason.trim()) e.preventDefault();
            }}
          >
            <input
              type="hidden"
              name="communicationIds"
              value={JSON.stringify([...selected])}
            />
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
              placeholder="Why are these drafts not right? Light learns from this."
              autoFocus
            />
            {state.error && !notice ? (
              <p className="text-[12.5px] text-stamp">
                {state.error}
                {state.failed
                  ? ` — ${state.rejected ?? 0} rejected, ${state.failed} failed`
                  : ""}
              </p>
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
                disabled={!reason.trim() || submitting || selected.size === 0}
              >
                {submitting
                  ? "Recording…"
                  : `Reject ${selected.size} with reason`}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
