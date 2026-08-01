"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { DecisionControls } from "./decision-controls";
import { WithdrawControl } from "./withdraw-control";
import { editDraftAction, type EditDraftState } from "./actions";

export interface CardCheck {
  key: string;
  label: string;
  pass: boolean;
  detail: string | null;
  /** Session 15 — the compliance check's finer state:
   * pending | stale | breach | unattested | clean. */
  state?: string;
}

/** Session 15 (PR-3) — Light's spend and sources, on the card at stamp time. */
export interface CardCreditLine {
  tier: string;
  model: string;
  reason: string;
  contextTokens: number;
  budgetTokens: number;
  attempts: number;
  packEntries: { id: string; title: string }[];
  /** Session 16 (PR-E) — provider cache figures, when the call was cached. */
  cache: { readTokens: number; writtenTokens: number; fallbackReason: string | null } | null;
}

export interface CardContext {
  engagementId: string | null;
  engagementTitle: string | null;
  stageLabel: string | null;
  answers: { label: string; value: string }[];
  source: string | null;
  formId: string | null;
  channels: { channel: string; value: string; consented: boolean }[];
}

export interface InboxCardProps {
  itemType: "communication" | "content" | "task" | "workflow_definition";
  itemId: string;
  /** Session 21 — a pending workflow definition offers exactly one control,
   * Withdraw, and only to the owner (canWithdrawWorkflowDefinition is the
   * single truth; the database refuses everyone else regardless). Approve
   * stays absent until the definition-approval pipeline's own session. */
  withdrawable: boolean;
  channelLabel: string;
  draftedBy: string | null;
  draftedByAgent: boolean;
  recipient: string | null;
  subject: string | null;
  /** Pre-formatted on the server: "42m", "3h 40m". */
  waitingFor: string;
  preview: string;
  fullBody: string | null;
  scheduledNote: string;
  /** Checks that actually ran — nothing else may show a tick. */
  checks: CardCheck[];
  preflightPass: boolean | null;
  /** Session 11 — the lead's context, expandable above the draft. */
  context: CardContext | null;
  /** Session 15 — the credit line, present on generated drafts only. */
  creditLine: CardCreditLine | null;
  /** Session 15 fix round — "edited by <name> · <time>", pre-formatted on
   * the server; a FACT in neutral chrome (not a stamp act, not a Light act). */
  editedNote: string | null;
  /** Session 16 (decision 133a) — "supersedes an earlier draft · N new
   * messages since", pre-formatted on the server; neutral chrome. */
  supersedeNote: string | null;
  /** Session 16 (PR-F) — approver sign-off mode: the body shown is the
   * render-resolved form (WYSIWYS); this note states the fact, neutrally. */
  signOffNote: string | null;
  /** PR-iii (Session 19) — the exact HTML the client will receive, rendered
   * by the same deterministic function dispatch uses over the same resolved
   * body. Email drafts only; null elsewhere. */
  emailHtmlPreview: string | null;
  /** PR-i (Session 19) — "⎘ Spouse-Guide.pdf · 1.2MB", pre-formatted on the
   * server; what the ATTACHMENTS pre-flight verified will actually ride. */
  attachmentNotes: string[];
  /** Session 12 — selection mode, for bulk REJECTION only. Approval never
   * takes a selection: the stamp is individual by constitution. */
  selection?: { selected: boolean; onToggle: () => void } | null;
}

/** Short names for the facts line, per pre-flight check key. */
const CHECK_NAMES: Record<string, string> = {
  body: "BODY",
  placeholders: "PLACEHOLDERS",
  consent: "CONSENT",
  attachment: "ATTACHMENTS",
  wa_session_window: "WA WINDOW",
  compliance: "COMPLIANCE",
};

/** Checks the database has not run yet (decision 19) — pending, never green.
 * Session 15: COMPLIANCE became a REAL check for rows the 0026 gate binds —
 * it appears in `checks` there; rows the gate does not bind (human-authored,
 * pre-migration) still show it here as pending, honestly unchecked. */
const NOT_YET_RUN = ["LINKS", "COMPLIANCE"];

function PreflightLine({
  checks,
  wired,
}: {
  checks: CardCheck[];
  wired: boolean;
}) {
  const hasRealCompliance = checks.some((c) => c.key === "compliance");
  const notYetRun = hasRealCompliance ? NOT_YET_RUN.filter((n) => n !== "COMPLIANCE") : NOT_YET_RUN;
  return (
    <div className="font-mono text-[10px] tracking-wide text-ink-faint uppercase">
      Pre-flight:{" "}
      {wired ? (
        <>
          {checks.map((check) => {
            // The compliance check distinguishes RED (a named breach — the
            // stamp is refused) from PENDING (not yet run on these exact
            // words — never green, decision 117 fail-closed).
            const pendingNotFailed =
              check.key === "compliance" && !check.pass && check.state !== "breach";
            return (
              <span key={check.key}>
                <span
                  className={
                    check.pass
                      ? "text-ledger"
                      : pendingNotFailed
                        ? undefined
                        : "font-semibold text-stamp"
                  }
                >
                  {CHECK_NAMES[check.key] ?? check.key}{" "}
                  {check.pass ? "✓" : pendingNotFailed ? (check.state === "stale" ? "re-check due" : "pending") : "✗"}
                </span>
                {" · "}
              </span>
            );
          })}
          {notYetRun.map((name, i) => (
            <span key={name}>
              {name} pending{i < notYetRun.length - 1 ? " · " : ""}
            </span>
          ))}
        </>
      ) : (
        <span>not yet wired for this item type — every check pending, never ticked</span>
      )}
    </div>
  );
}

/** Session 15 (PR-3): tier, escalation reason, budget and the pack entries
 * used — Light's channel, so the spark wears gold; the facts stay mono. */
function CreditLine({ credit }: { credit: CardCreditLine }) {
  return (
    <div className="font-mono text-[10px] tracking-wide text-ink-faint uppercase">
      <span className="light-text">✦ Light</span>
      {` · ${credit.tier} (${credit.model})`}
      {` · ${credit.reason === "floor" ? "floor — no escalation" : `escalated: ${credit.reason}`}`}
      {` · context ${credit.contextTokens}/${credit.budgetTokens} tok`}
      {credit.attempts > 1 ? ` · attempt ${credit.attempts} (redrafted after a compliance breach)` : ""}
      {/* Session 16 (PR-E): the cache figures, verified from the provider's
          own usage fields — a recorded fallback reason when caching was
          refused, never a silent difference. */}
      {credit.cache
        ? ` · cache: ${credit.cache.readTokens} read / ${credit.cache.writtenTokens} written${
            credit.cache.fallbackReason ? " (fell back uncached — reason recorded)" : ""
          }`
        : ""}
      {` · pack: ${credit.packEntries.length ? credit.packEntries.map((e) => e.title).join(", ") : "no entries used"}`}
    </div>
  );
}

function ContextSection({ context }: { context: CardContext }) {
  const [open, setOpen] = useState(false);
  const hasFacts =
    context.answers.length > 0 || context.channels.length > 0 || context.source !== null;
  if (!hasFacts) return null;

  return (
    <div className="mt-2 rounded-lg border border-dashed border-rule">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left font-mono text-[10px] tracking-wide text-ink-soft uppercase"
      >
        Lead context {context.engagementTitle ? `· ${context.engagementTitle}` : ""}
        <span className="ml-auto text-ink-faint">{open ? "− collapse" : "+ expand"}</span>
      </button>
      {open ? (
        <div className="border-t border-dashed border-rule px-3 py-2.5 text-[12.5px]">
          <div className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
            {context.stageLabel ? (
              <>
                <span className="font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">Stage</span>
                <span>{context.stageLabel}</span>
              </>
            ) : null}
            {context.answers.map((a) => (
              <span key={a.label} className="contents">
                <span className="font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">{a.label}</span>
                <span>{a.value}</span>
              </span>
            ))}
            {context.source ? (
              <>
                <span className="font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">Source</span>
                <span>
                  {context.source === "meta" ? "Meta lead form" : context.source}
                  {context.formId ? ` · form ${context.formId}` : ""}
                </span>
              </>
            ) : null}
            {context.channels.map((c) => (
              <span key={`${c.channel}-${c.value}`} className="contents">
                <span className="font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">{c.channel}</span>
                <span>
                  {c.value}{" "}
                  <span className={c.consented ? "text-ledger" : "text-stamp"}>
                    {c.consented ? "· consented" : "· no consent"}
                  </span>
                </span>
              </span>
            ))}
          </div>
          <p className="mt-2 font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">
            Shown here: everything the database holds — form answers verbatim as the lead gave them.
          </p>
        </div>
      ) : null}
    </div>
  );
}

const EDIT_INITIAL: EditDraftState = { error: null };

export function InboxCard(props: InboxCardProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [showHtml, setShowHtml] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editState, editFormAction, editPending] = useActionState(editDraftAction, EDIT_INITIAL);
  const failures = props.checks.filter((c) => !c.pass && c.detail);
  const isComm = props.itemType === "communication";
  const canExpand = props.fullBody !== null && props.fullBody !== props.preview;

  useEffect(() => {
    if (editState.saved) {
      setEditing(false);
      router.refresh();
    }
  }, [editState.saved, router]);

  return (
    <div
      className={cn(
        "glass rounded-xl px-4 py-3.5",
        props.selection?.selected && "ring-1 ring-accent"
      )}
    >
      {/* The facts line: channel, who drafted, for whom, waiting how long. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {props.selection ? (
          <button
            type="button"
            role="checkbox"
            aria-checked={props.selection.selected}
            aria-label={`Select for rejection: ${props.subject ?? props.preview}`}
            onClick={props.selection.onToggle}
            className={cn(
              "mr-1 flex size-[18px] shrink-0 cursor-pointer items-center justify-center rounded border transition-colors",
              props.selection.selected
                ? "border-accent bg-accent text-white"
                : "border-rule bg-paper hover:border-accent"
            )}
          >
            {props.selection.selected ? (
              <Check className="size-3" strokeWidth={3.5} />
            ) : null}
          </button>
        ) : null}
        <Badge variant="source">{props.channelLabel}</Badge>
        {props.draftedByAgent ? (
          <Badge variant="gold">
            <Sparkles className="size-3" /> drafted by {props.draftedBy ?? "Light"}
          </Badge>
        ) : (
          <Badge variant="time">drafted by {props.draftedBy ?? "unknown"}</Badge>
        )}
        {props.editedNote ? <Badge variant="time">{props.editedNote}</Badge> : null}
        {/* PR-i: the document riding this send — declared, verified, named. */}
        {props.attachmentNotes.map((note) => (
          <Badge key={note} variant="source">
            {note}
          </Badge>
        ))}
        {/* Session 16 (decision 133a): what this draft replaced — a fact in
            neutral chrome; the superseded row itself lives in History. */}
        {props.supersedeNote ? <Badge variant="time">{props.supersedeNote}</Badge> : null}
        <span className="text-[12.5px] font-medium text-ink-soft">
          {props.recipient ? `→ ${props.recipient}` : null}
          {props.recipient && props.subject ? " · " : null}
          {props.subject}
        </span>
        <span className="ml-auto font-mono text-[10px] text-ink-faint">
          waiting {props.waitingFor}
        </span>
      </div>

      {/* The lead's form answers and consent, above the draft (Session 11 —
          glance and stamp without leaving the inbox). */}
      {props.context ? <ContextSection context={props.context} /> : null}

      {/* The message: readable in place, or editable before the stamp
          (Session 15, signed amendment 2 — WYSIWYS: the stamp approves the
          words as edited, and the pre-flight re-runs on exactly those words). */}
      {editing ? (
        <form action={editFormAction} className="my-2">
          <input type="hidden" name="communicationId" value={props.itemId} />
          <Textarea
            name="body"
            defaultValue={props.fullBody ?? props.preview}
            rows={8}
            autoFocus
            className="text-[13.5px]"
          />
          {editState.error ? <p className="mt-1.5 text-[12px] text-stamp">{editState.error}</p> : null}
          <div className="mt-2 flex items-center gap-2">
            <p className="font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">
              Saving re-runs the pre-flight — compliance included — on these exact words; the edit lands in
              draft_feedback and on The Record.
            </p>
            <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={editPending}>
              {editPending ? "Saving…" : "Save & re-check"}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <button
            type="button"
            onClick={() => canExpand && setOpen((v) => !v)}
            aria-expanded={open}
            className={cn(
              "my-2 block w-full rounded-lg border border-rule bg-paper px-3 py-2.5 text-left text-[13.5px] text-ink",
              canExpand && "cursor-pointer transition-colors hover:border-ledger"
            )}
          >
            <span className={cn(!open && "line-clamp-2", (open || showHtml) && "whitespace-pre-wrap")}>
              {open || showHtml ? (props.fullBody ?? props.preview) : props.preview}
            </span>
            {canExpand ? (
              <span className="mt-1.5 block font-mono text-[10px] tracking-wide text-ink-faint uppercase">
                {open ? "— tap to collapse" : "— tap to open the full message"}
              </span>
            ) : null}
          </button>
          {/* PR-iii (Session 19): WYSIWYS for the HTML dress — the stamp view
              shows the rendered mail the client will receive, produced by the
              same deterministic renderer dispatch uses on these exact words. */}
          {props.emailHtmlPreview ? (
            <div className="my-2">
              <button
                type="button"
                onClick={() => setShowHtml((v) => !v)}
                aria-expanded={showHtml}
                className="cursor-pointer font-mono text-[10px] tracking-wide text-accent uppercase hover:underline"
              >
                {showHtml ? "− hide the rendered email" : "+ view as the client will receive it (HTML)"}
              </button>
              {showHtml ? (
                <iframe
                  title="Rendered email — exactly what sends"
                  sandbox=""
                  srcDoc={props.emailHtmlPreview}
                  className="mt-1.5 h-[340px] w-full rounded-lg border border-rule bg-white"
                />
              ) : null}
            </div>
          ) : null}
        </>
      )}

      <div className="mb-2 flex flex-col gap-1">
        <PreflightLine checks={props.checks} wired={isComm} />
        {props.creditLine ? <CreditLine credit={props.creditLine} /> : null}
        {/* Session 16 (PR-F): the sign-off fact — WYSIWYS, stated in neutral
            mono; the body above already shows the resolved form. */}
        {props.signOffNote ? (
          <div className="font-mono text-[10px] tracking-wide text-ink-faint uppercase">
            {props.signOffNote}
          </div>
        ) : null}
        <div className="font-mono text-[10px] tracking-wide text-ink-faint uppercase">
          {props.scheduledNote}
        </div>
        {failures.map((f) => (
          <div key={f.key} className="text-[12px] text-stamp">
            {f.detail}
          </div>
        ))}
      </div>

      {/* Actions inline on the card. */}
      {isComm ? (
        <DecisionControls
          communicationId={props.itemId}
          preflightPass={props.preflightPass === true}
          blockedDetails={failures.map((f) => f.detail as string)}
          onEdit={editing ? undefined : () => setEditing(true)}
        />
      ) : props.itemType === "workflow_definition" ? (
        <div className="flex flex-col gap-1.5">
          {props.withdrawable ? <WithdrawControl definitionId={props.itemId} /> : null}
          <p className="text-[12.5px] text-ink-soft">
            {props.withdrawable
              ? "Approve arrives with the definition-approval pipeline in a later session — withdrawing is the only act this card offers."
              : "The approve/reject pipeline for workflow definitions arrives in a later session — only the owner may withdraw this proposal."}
          </p>
        </div>
      ) : (
        <p className="text-[12.5px] text-ink-soft">
          The approve/reject pipeline for {props.itemType} items arrives in a
          later session — this row is read-only until then.
        </p>
      )}
    </div>
  );
}
