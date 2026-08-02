"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DecisionControls } from "../inbox/decision-controls";
import { editDraftAction, type EditDraftState } from "../inbox/actions";
import { PreflightLine, type CardCheck } from "../inbox/inbox-card";

/*
 * Session 23 (WS1b, founder-ruled) — the inline stamp in Conversations.
 * The draft bubble in a thread gains Approve / Edit / Reject invoking the
 * SAME server acts as the Approval Inbox (approveAction / rejectAction /
 * editDraftAction — one row, two views, one stamp; s16 PR-D finished
 * properly). All gate laws hold here exactly as in the inbox: the pre-flight
 * state is visible, the Approve button is withheld when blocked (never
 * merely discouraged), and the body shown above is the render-resolved
 * WYSIWYS form for a stamp-authority viewer. No new pipeline exists — the
 * inbox remains the queue view; this is the thread view of the same stamp.
 */

export interface ThreadDraftStamp {
  communicationId: string;
  checks: CardCheck[];
  preflightPass: boolean;
  /** The render-resolved body (WYSIWYS) — the bubble shows THIS. */
  body: string;
  signOffNote: string | null;
  creditNote: string | null;
}

const EDIT_INITIAL: EditDraftState = { error: null };

export function DraftStampPanel({
  stamp,
  returnTo,
}: {
  stamp: ThreadDraftStamp;
  returnTo: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [editState, editFormAction, editPending] = useActionState(editDraftAction, EDIT_INITIAL);
  const failures = stamp.checks.filter((c) => !c.pass && c.detail);

  useEffect(() => {
    if (editState.saved) {
      setEditing(false);
      router.refresh();
    }
  }, [editState.saved, router]);

  return (
    <div className="flex w-full max-w-[72%] flex-col gap-1.5 self-end">
      <PreflightLine checks={stamp.checks} wired />
      {stamp.signOffNote ? (
        <div className="font-mono text-[10px] tracking-wide text-ink-faint uppercase">
          {stamp.signOffNote}
        </div>
      ) : null}
      {stamp.creditNote ? (
        <div className="font-mono text-[10px] tracking-wide text-ink-faint uppercase">
          {stamp.creditNote}
        </div>
      ) : null}
      {editing ? (
        <form action={editFormAction}>
          <input type="hidden" name="communicationId" value={stamp.communicationId} />
          <Textarea
            name="body"
            defaultValue={stamp.body}
            rows={6}
            autoFocus
            className="text-[13px]"
          />
          {editState.error ? (
            <p className="mt-1.5 text-[12px] text-stamp">{editState.error}</p>
          ) : null}
          <div className="mt-1.5 flex items-center gap-2">
            <p className="font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">
              Saving re-runs the pre-flight — compliance included — on these exact words.
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={editPending}>
              {editPending ? "Saving…" : "Save & re-check"}
            </Button>
          </div>
        </form>
      ) : (
        <DecisionControls
          communicationId={stamp.communicationId}
          preflightPass={stamp.preflightPass}
          blockedDetails={failures.map((f) => f.detail as string)}
          onEdit={() => setEditing(true)}
          returnTo={returnTo}
        />
      )}
    </div>
  );
}
