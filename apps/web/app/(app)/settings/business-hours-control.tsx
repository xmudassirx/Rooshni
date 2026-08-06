"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { setBusinessHoursAction, type BusinessHoursActionState } from "./actions";

/*
 * Defect-trio hotfix (2 Aug 2026, item 3) — the business-hours editor. A
 * simple daily send window (open→close) in the business's timezone; the save
 * writes settings.quiet_hours — the ONE config the dispatch hold reads — so
 * what this control shows is exactly what the hold enforces. Until the firm
 * sets it, the shipped default is stated honestly as a default, never
 * presented as the firm's own choice.
 *
 * Session 33 (D184b): NO QUIET HOURS is a first-class choice beside the
 * window config — owner-set, evented, the D170 explicit-null path. A firm
 * working deportation cases at midnight sends at midnight. The off state
 * renders honestly, and the owner can turn the window back on here too.
 */

const INITIAL: BusinessHoursActionState = { error: null };

export interface BusinessHoursValue {
  open: string;
  close: string;
  timezone: string;
  /** false = the shipped default is in force — "not yet set by you". */
  isSet: boolean;
  /** null window = quiet hours OFF — the owner's D184b choice. */
  disabled: boolean;
  isOwner: boolean;
  /** Fact-surfaces micro-fix (defect B): the opening-hours MEMORY fact —
   * the single home this field writes through — rendered memory-first; the
   * derived window string is only the pre-fact fallback. Null = no fact. */
  memoryValue?: string | null;
}

export function BusinessHoursControl({ value }: { value: BusinessHoursValue }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(setBusinessHoursAction, INITIAL);
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(value.open);
  const [close, setClose] = useState(value.close);

  useEffect(() => {
    if (state.saved) {
      setEditing(false);
      router.refresh();
    }
  }, [state.saved, router]);

  if (!editing) {
    return (
      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12.5px]">
        {value.disabled ? (
          // Session 33 (D184b, as amended at click-review): the off state
          // states BOTH truths — dispatch is any-hour, while the
          // client-facing opening-hours fact (when one stands) lives on.
          <span className="text-ink">
            Quiet hours off — stamped mail dispatches immediately, any hour
            {value.memoryValue ? (
              <span className="text-ink-soft"> · Opening hours unchanged: {value.memoryValue}</span>
            ) : null}
          </span>
        ) : value.memoryValue ? (
          // Fact-surfaces micro-fix (defect B): the memory fact is the value
          // shown — the same home the save writes through; the derived
          // window renders only before a fact exists.
          <span className="text-ink">
            {value.memoryValue}
            <span className="font-mono text-[9px] tracking-wide text-ink-faint uppercase"> · from Light&rsquo;s Memory</span>
          </span>
        ) : (
          <span className="text-ink">
            {value.open}–{value.close}
            <span className="text-ink-soft"> · {value.timezone}</span>
          </span>
        )}
        {!value.disabled && !value.isSet && !value.memoryValue ? (
          <span className="font-mono text-[9px] tracking-wide text-ink-faint uppercase">
            default — not yet set by you
          </span>
        ) : null}
        {value.isOwner ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="cursor-pointer font-mono text-[9.5px] font-semibold tracking-wide text-accent uppercase hover:underline"
          >
            edit
          </button>
        ) : null}
      </span>
    );
  }

  return (
    <div className="text-[12.5px]">
      <form action={formAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="mode" value="set" />
        <label className="flex items-center gap-1.5 font-mono text-[9.5px] tracking-wide text-ink-soft uppercase">
          open
          <input
            type="time"
            name="open"
            value={open}
            onChange={(e) => setOpen(e.target.value)}
            required
            className="rounded-md border border-rule bg-paper px-1.5 py-1 font-sans text-[12px] text-ink"
          />
        </label>
        <label className="flex items-center gap-1.5 font-mono text-[9.5px] tracking-wide text-ink-soft uppercase">
          close
          <input
            type="time"
            name="close"
            value={close}
            onChange={(e) => setClose(e.target.value)}
            required
            className="rounded-md border border-rule bg-paper px-1.5 py-1 font-sans text-[12px] text-ink"
          />
        </label>
        <span className="font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">
          {value.timezone}
        </span>
        <button
          type="submit"
          disabled={pending}
          className="cursor-pointer rounded-md border border-accent/50 bg-accent/10 px-2 py-1 font-mono text-[9.5px] font-semibold tracking-wide text-accent uppercase disabled:opacity-60"
        >
          {pending ? "saving…" : "save"}
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="cursor-pointer font-mono text-[9.5px] tracking-wide text-ink-faint uppercase hover:underline"
        >
          cancel
        </button>
      </form>
      {/* Session 33 (D184b): the first-class choice beside the window
          config — quiet hours OFF entirely, the explicit-null path. */}
      {!value.disabled ? (
        <form action={formAction} className="mt-1.5">
          <input type="hidden" name="mode" value="disable" />
          <button
            type="submit"
            disabled={pending}
            className="cursor-pointer rounded-md border border-rule bg-paper px-2 py-1 font-mono text-[9.5px] font-semibold tracking-wide text-ink-soft uppercase hover:border-accent hover:text-ink disabled:opacity-60"
          >
            no quiet hours — dispatch any hour
          </button>
        </form>
      ) : (
        <p className="mt-1.5 font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">
          quiet hours are off — saving a window above turns them back on
        </p>
      )}
      {value.isSet && !value.disabled ? (
        <form action={formAction} className="mt-1">
          <input type="hidden" name="mode" value="reset" />
          <button
            type="submit"
            disabled={pending}
            className="cursor-pointer font-mono text-[9px] tracking-wide text-ink-faint uppercase hover:underline disabled:opacity-60"
          >
            reset to the shipped default
          </button>
        </form>
      ) : null}
      {state.error ? <p className="mt-1 text-[12px] text-stamp">{state.error}</p> : null}
      <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
        Messages stamped outside these hours meet the choice at the stamp: send now (recorded), or
        approve and schedule a dispatch time. With no quiet hours, stamped mail dispatches
        immediately, any hour.
      </p>
    </div>
  );
}
