"use client";

import { useState } from "react";
import { Check, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { DecisionControls } from "./decision-controls";

export interface CardCheck {
  key: string;
  label: string;
  pass: boolean;
  detail: string | null;
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
  itemType: "communication" | "content" | "task";
  itemId: string;
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
};

/** Checks the database has not run yet (decision 19) — pending, never green. */
const NOT_YET_RUN = ["LINKS", "COMPLIANCE"];

function PreflightLine({
  checks,
  wired,
}: {
  checks: CardCheck[];
  wired: boolean;
}) {
  return (
    <div className="font-mono text-[10px] tracking-wide text-ink-faint uppercase">
      Pre-flight:{" "}
      {wired ? (
        <>
          {checks.map((check) => (
            <span key={check.key}>
              <span className={check.pass ? "text-ledger" : "font-semibold text-stamp"}>
                {CHECK_NAMES[check.key] ?? check.key} {check.pass ? "✓" : "✗"}
              </span>
              {" · "}
            </span>
          ))}
          {NOT_YET_RUN.map((name, i) => (
            <span key={name}>
              {name} pending{i < NOT_YET_RUN.length - 1 ? " · " : ""}
            </span>
          ))}
        </>
      ) : (
        <span>not yet wired for this item type — every check pending, never ticked</span>
      )}
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
            Full form answers arrive with query-aware drafting (Phase 2) — shown here: everything the database holds.
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function InboxCard(props: InboxCardProps) {
  const [open, setOpen] = useState(false);
  const failures = props.checks.filter((c) => !c.pass && c.detail);
  const isComm = props.itemType === "communication";
  const canExpand = props.fullBody !== null && props.fullBody !== props.preview;

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

      {/* The message, readable in place; clicking opens the full text. */}
      <button
        type="button"
        onClick={() => canExpand && setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "my-2 block w-full rounded-lg border border-rule bg-paper px-3 py-2.5 text-left text-[13.5px] text-ink",
          canExpand && "cursor-pointer transition-colors hover:border-ledger"
        )}
      >
        <span className={cn(!open && "line-clamp-2", open && "whitespace-pre-wrap")}>
          {open ? (props.fullBody ?? props.preview) : props.preview}
        </span>
        {canExpand ? (
          <span className="mt-1.5 block font-mono text-[10px] tracking-wide text-ink-faint uppercase">
            {open ? "— tap to collapse" : "— tap to open the full message"}
          </span>
        ) : null}
      </button>

      <div className="mb-2 flex flex-col gap-1">
        <PreflightLine checks={props.checks} wired={isComm} />
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
        />
      ) : (
        <p className="text-[12.5px] text-ink-soft">
          The approve/reject pipeline for {props.itemType} items arrives in a
          later session — this row is read-only until then.
        </p>
      )}
    </div>
  );
}
