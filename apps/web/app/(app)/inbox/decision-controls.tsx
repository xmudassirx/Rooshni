"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, CalendarClock, Check, Stamp } from "lucide-react";

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
  approveAction,
  rejectAction,
  sendNowAction,
  type DecisionState,
  type SendNowState,
} from "./actions";
import { formatSendsAt } from "@/lib/held-until";
import { STANDING_REASON } from "./standing-reason";

const initialState: DecisionState = { error: null };

/** The viewer-local value a datetime-local input wants for an instant. */
function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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
  const [sendNowState, sendNow, sendingNow] = useActionState(sendNowAction, {
    error: null,
  } as SendNowState);
  const [rejectState, reject, rejecting] = useActionState(rejectAction, initialState);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  // Session 33 (D184c) — the choice at the stamp. The server WITHHELD the
  // stamp because the destination's quiet window is active; this dialogue
  // (shared by the inbox card and the thread's inline approve — one
  // component, both surfaces) is the only path onward: Send now, or
  // Approve and schedule. Rejection needs no dialogue.
  const [quietOpen, setQuietOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");
  const router = useRouter();

  const quietUntil = approveState.quietChoiceRequired?.until ?? null;
  useEffect(() => {
    if (!quietUntil || approveState.stamped) return;
    setScheduleAt(toLocalInputValue(quietUntil));
    setQuietOpen(true);
  }, [approveState, quietUntil]);

  // Session 11 (founder-ruled): a stamped row never disappears instantly —
  // it shows its transient state, then leaves for History on the refresh.
  // Defect-trio hotfix (2 Aug 2026, item 2): a HELD stamp does not auto-leave
  // — the hold must be read, and Send now must be reachable, before the card
  // departs; the refresh is the reader's own act then. Session 33: a
  // SCHEDULED stamp likewise stays until read — the chosen time is the card's
  // whole point.
  useEffect(() => {
    if (!approveState.stamped || approveState.heldUntil || approveState.scheduledFor) return;
    const t = window.setTimeout(() => router.refresh(), 2200);
    return () => window.clearTimeout(t);
  }, [approveState.stamped, approveState.heldUntil, approveState.scheduledFor, router]);

  useEffect(() => {
    if (!sendNowState.sent) return;
    const t = window.setTimeout(() => router.refresh(), 1600);
    return () => window.clearTimeout(t);
  }, [sendNowState.sent, router]);

  // Session 33 (D184c, B4): the card states the truth after the choice.
  if (approveState.stamped && approveState.scheduledFor) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-ledger/40 bg-ledger/10 px-3 py-2 text-[13px] font-semibold text-ledger">
        <Check className="size-4" strokeWidth={3} />
        <span>Stamped — on The Record</span>
        <span className="font-mono text-[10px] font-normal tracking-wide uppercase opacity-80">
          stamped · scheduled for {formatSendsAt(approveState.scheduledFor)} · your stamp, your chosen time
        </span>
        <button
          type="button"
          onClick={() => router.refresh()}
          className="cursor-pointer font-mono text-[9.5px] tracking-wide text-ink-faint uppercase hover:underline"
        >
          done
        </button>
      </div>
    );
  }

  if (approveState.stamped && approveState.heldUntil && !sendNowState.sent) {
    // Neutral chrome, deliberately: the hold is POLICY working as configured
    // — not gold (Light did nothing here), not red (nothing is owed), not
    // green (nothing has sent). Since Session 33 this is a race-window
    // fallback only — the D184c dialogue gates the stamp beforehand.
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-rule bg-paper-deep px-3 py-2 text-[13px] text-ink">
        <Check className="size-4" strokeWidth={3} />
        <span className="font-semibold">Approved — held by quiet hours</span>
        <span className="font-mono text-[10px] tracking-wide uppercase opacity-80">
          sends {formatSendsAt(approveState.heldUntil)} · your stamp, the timing is policy
        </span>
        <form action={sendNow}>
          <input type="hidden" name="communicationId" value={communicationId} />
          <Button size="sm" variant="ghost" disabled={sendingNow}>
            {sendingNow ? "Sending…" : "Send now"}
          </Button>
        </form>
        <button
          type="button"
          onClick={() => router.refresh()}
          className="cursor-pointer font-mono text-[9.5px] tracking-wide text-ink-faint uppercase hover:underline"
        >
          keep the hold
        </button>
        {sendNowState.error ? (
          <span className="w-full text-[12px] text-stamp">{sendNowState.error}</span>
        ) : null}
      </div>
    );
  }

  if (approveState.stamped) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-ledger/40 bg-ledger/10 px-3 py-2 text-[13px] font-semibold text-ledger">
        <Check className="size-4" strokeWidth={3} /> Stamped — on The Record
        <span className="font-mono text-[10px] font-normal tracking-wide uppercase opacity-80">
          {approveState.sentNow
            ? "stamped · sent now (quiet-hours override)"
            : sendNowState.sent
              ? "sent now — your recorded call"
              : "dispatching now · find it again under History"}
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

      {/* Session 33 (D184c) — THE CHOICE AT THE STAMP. The server withheld
          the stamp (quiet window active, no choice given); the dialogue
          names the window and offers exactly two acts. Once-per-event
          surface (barakah-motion tier 3): 200ms entrance on --motion-out,
          transform + opacity only; the global reduced-motion kill covers it. */}
      {quietUntil ? (
        <Dialog open={quietOpen} onOpenChange={setQuietOpen}>
          <DialogContent className="quiet-choice-in">
            <DialogHeader>
              <DialogTitle>Quiet hours until {formatSendsAt(quietUntil)}</DialogTitle>
              <DialogDescription>
                This client&rsquo;s quiet window is active. Your stamp is
                yours either way: send it now as your recorded call, or
                approve it and choose when it dispatches. The words that send
                are the words above, exactly.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <form action={approve} className="flex items-center gap-2">
                <input type="hidden" name="communicationId" value={communicationId} />
                <input type="hidden" name="quietChoice" value="send_now" />
                <Button variant="approve" size="sm" disabled={approving}>
                  <Stamp /> {approving ? "Stamping…" : "Send now"}
                </Button>
                <span className="font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">
                  the override is recorded, with your name
                </span>
              </form>
              <form action={approve} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="communicationId" value={communicationId} />
                <input type="hidden" name="quietChoice" value="schedule" />
                <input
                  type="hidden"
                  name="scheduledFor"
                  value={scheduleAt ? new Date(scheduleAt).toISOString() : ""}
                />
                <Button variant="primary" size="sm" disabled={approving || !scheduleAt}>
                  <CalendarClock /> {approving ? "Stamping…" : "Approve and schedule"}
                </Button>
                <input
                  type="datetime-local"
                  value={scheduleAt}
                  min={toLocalInputValue(new Date().toISOString())}
                  onChange={(e) => setScheduleAt(e.target.value)}
                  aria-label="Dispatch time"
                  className="rounded-md border border-rule bg-paper px-2 py-1 font-sans text-[12.5px] text-ink"
                />
                <span className="w-full font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">
                  defaults to the window&rsquo;s end · any future time is yours to pick
                </span>
              </form>
              {approveState.error ? (
                <p className="text-[12.5px] text-stamp">{approveState.error}</p>
              ) : null}
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" size="sm">
                  Cancel — nothing stamped
                </Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {!preflightPass && blockedDetails.length > 0 ? (
        <p className="text-[12.5px] text-stamp">
          {blockedDetails.join(" · ")} — fix the failure, then the stamp appears.
        </p>
      ) : null}
      {approveState.error && !quietOpen ? (
        <p className="text-[12.5px] text-stamp">{approveState.error}</p>
      ) : null}
    </div>
  );
}
