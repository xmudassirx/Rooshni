"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { updateDraftingSettingsAction, type DraftingSettingsState } from "./actions";

/*
 * Session 16 — Settings → General: the drafting policy controls.
 *   - Email sign-off text (the Session 15 JUDGMENT mark redeemed): the firm
 *     display name is the only shipped default — never a personal name
 *     unless the firm itself writes one here.
 *   - Sign-off mode (PR-F, decision 133e): firm name, or resolved to the
 *     stamping approver at the stamp — WYSIWYS-preserving; the card shows
 *     the resolved body before the stamp.
 *   - Settle window (PR-C, decision 133b): how long Light waits after a
 *     client message before drafting — honest about the trade.
 */

const INITIAL: DraftingSettingsState = { error: null };

const SETTLE_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: "Instant" },
  { value: 1, label: "1 minute" },
  { value: 3, label: "3 minutes (default)" },
  { value: 5, label: "5 minutes" },
];

export function DraftingSettings({
  signOffText,
  signOffMode,
  settleMinutes,
  businessName,
  isOwner,
}: {
  signOffText: string | null;
  signOffMode: "firm_name" | "approver";
  settleMinutes: number;
  businessName: string;
  isOwner: boolean;
}) {
  const [state, formAction, pending] = useActionState(updateDraftingSettingsAction, INITIAL);

  return (
    <form action={formAction} className="glass mt-3 rounded-xl px-4 py-3.5">
      <h3 className="mb-1 font-mono text-[9.5px] font-semibold tracking-[.08em] text-ink-faint uppercase">
        Drafting &amp; sign-off
      </h3>

      <div className="flex flex-col gap-3 pt-1.5">
        <label className="block">
          <span className="mb-1 block font-mono text-[9.5px] font-semibold tracking-[.08em] text-ink-faint uppercase">
            Email sign-off
          </span>
          <input
            name="email_sign_off"
            defaultValue={signOffText ?? ""}
            placeholder={businessName}
            disabled={!isOwner}
            className="w-full max-w-[360px] rounded-lg border border-rule bg-paper px-3 py-2 text-[13px] text-ink outline-none focus:outline-2 focus:-outline-offset-1 focus:outline-accent disabled:opacity-60"
          />
          <span className="mt-1 block text-[11px] text-ink-faint">
            Blank means the firm&rsquo;s display name — the only shipped default. Light signs every
            draft with this and nothing else.
          </span>
        </label>

        <fieldset>
          <legend className="mb-1 font-mono text-[9.5px] font-semibold tracking-[.08em] text-ink-faint uppercase">
            Sign-off mode
          </legend>
          {(
            [
              ["firm_name", "Firm name", "Every draft signs off with the text above."],
              [
                "approver",
                "Approver, resolved at the stamp",
                "The pending draft carries the firm name; when a stamp-holder opens the card, the sign-off shows as their name — what they see at the stamp is exactly what sends.",
              ],
            ] as const
          ).map(([value, label, help]) => (
            <label key={value} className="mb-1.5 flex items-start gap-2 text-[13px]">
              <input
                type="radio"
                name="email_sign_off_mode"
                value={value}
                defaultChecked={signOffMode === value}
                disabled={!isOwner}
                className="mt-1 accent-[var(--accent)]"
              />
              <span>
                <b className="font-semibold">{label}</b>
                <span className="block text-[11px] text-ink-faint">{help}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <label className="block">
          <span className="mb-1 block font-mono text-[9.5px] font-semibold tracking-[.08em] text-ink-faint uppercase">
            Reply settle window
          </span>
          <select
            name="draft_settle_minutes"
            defaultValue={String(settleMinutes)}
            disabled={!isOwner}
            className="w-full max-w-[220px] rounded-lg border border-rule bg-paper px-3 py-2 text-[13px] text-ink outline-none focus:outline-2 focus:-outline-offset-1 focus:outline-accent disabled:opacity-60"
          >
            {SETTLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-[11px] text-ink-faint">
            How long Light waits after a client&rsquo;s message before drafting a reply, so a burst
            of messages settles into one draft. Faster drafts may answer an unfinished thought.
            Each conversation can override this from its own header.
          </span>
        </label>
      </div>

      <div className="mt-3 flex items-center gap-2 border-t border-dashed border-paper-deep pt-2.5">
        <p
          className={cn(
            "font-mono text-[9.5px] tracking-[.04em]",
            state.error ? "text-stamp" : state.saved ? "text-ledger" : "text-ink-faint"
          )}
        >
          {state.error
            ? state.error
            : state.saved
              ? "Saved — the change is a line on The Record (settings.updated)."
              : isOwner
                ? "Business-level policy — saving writes settings.updated to The Record."
                : "Drafting policy is the owner's pen."}
        </p>
        <Button type="submit" variant="primary" size="sm" className="ml-auto" disabled={pending || !isOwner}>
          {pending ? "Saving…" : "Save drafting policy"}
        </Button>
      </div>
    </form>
  );
}
