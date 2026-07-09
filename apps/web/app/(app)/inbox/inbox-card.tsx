"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { DecisionControls } from "./decision-controls";

export interface CardCheck {
  key: string;
  label: string;
  pass: boolean;
  detail: string | null;
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

export function InboxCard(props: InboxCardProps) {
  const [open, setOpen] = useState(false);
  const failures = props.checks.filter((c) => !c.pass && c.detail);
  const isComm = props.itemType === "communication";
  const canExpand = props.fullBody !== null && props.fullBody !== props.preview;

  return (
    <div className="glass rounded-xl px-4 py-3.5">
      {/* The facts line: channel, who drafted, for whom, waiting how long. */}
      <div className="flex flex-wrap items-center gap-1.5">
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
