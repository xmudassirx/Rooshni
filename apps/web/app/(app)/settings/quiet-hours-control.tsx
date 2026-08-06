"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { setBusinessHoursAction, type BusinessHoursActionState } from "./actions";

/*
 * Quiet-window micro-fix (7 Aug 2026, founder-witnessed) — the Quiet hours
 * row states the D170-resolved window WITH ITS TRUE SOURCE (firm-set /
 * template default / shipped default / off), never a claimed derivation
 * from business hours; and the window gains an editor of its own. ONE
 * DOOR: both acts post to setBusinessHoursAction — the firm window as the
 * set_quiet arm (dispatch policy only; the opening-hours fact untouched),
 * and no-quiet-hours as the SAME s33 disable arm the Business hours
 * editor's toggle uses, never a second implementation.
 */

const INITIAL: BusinessHoursActionState = { error: null };

const SOURCE_LABELS = {
  firm: "firm-set",
  template: "template default",
  shipped: "shipped default",
} as const;

export interface QuietHoursValue {
  /** The resolved window; null = quiet hours OFF (the D184b choice). */
  start: string | null;
  end: string | null;
  source: "firm" | "template" | "shipped" | "off";
  isOwner: boolean;
}

export function QuietHoursControl({ value }: { value: QuietHoursValue }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(setBusinessHoursAction, INITIAL);
  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState(value.start ?? "20:00");
  const [end, setEnd] = useState(value.end ?? "08:00");

  useEffect(() => {
    if (state.saved) {
      setEditing(false);
      router.refresh();
    }
  }, [state.saved, router]);

  if (!editing) {
    return (
      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12.5px]">
        {value.source === "off" ? (
          <span className="text-ink">Off — dispatch any hour</span>
        ) : (
          <span className="text-ink">
            {value.start}–{value.end}
            <span className="font-mono text-[9px] tracking-wide text-ink-faint uppercase">
              {" "}
              · {SOURCE_LABELS[value.source]}
            </span>
          </span>
        )}
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
        <input type="hidden" name="mode" value="set_quiet" />
        <label className="flex items-center gap-1.5 font-mono text-[9.5px] tracking-wide text-ink-soft uppercase">
          start
          <input
            type="time"
            name="start"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            required
            className="rounded-md border border-rule bg-paper px-1.5 py-1 font-sans text-[12px] text-ink"
          />
        </label>
        <label className="flex items-center gap-1.5 font-mono text-[9.5px] tracking-wide text-ink-soft uppercase">
          end
          <input
            type="time"
            name="end"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            required
            className="rounded-md border border-rule bg-paper px-1.5 py-1 font-sans text-[12px] text-ink"
          />
        </label>
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
      {value.source !== "off" ? (
        // The s33 choice, the SAME disable arm — one door, never a second
        // implementation.
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
          quiet hours are off — saving a window turns them back on
        </p>
      )}
      {state.error ? <p className="mt-1 text-[12px] text-stamp">{state.error}</p> : null}
      <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
        The quiet window is dispatch policy only — setting it here never changes the opening hours
        stated to clients, which live in Light&rsquo;s Memory.
      </p>
    </div>
  );
}
