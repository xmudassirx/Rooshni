"use client";

import { useActionState, useState } from "react";

import { reclassifyRouteAction, type ReclassifyRouteState } from "./actions";

/*
 * Session 27 (D161c): the reclassify control — a dropdown of the template's
 * declared routes with an optional reason, open to any team member with
 * enquiry access. The database's 0042 door is the enforcement; this is only
 * the pen. A human-set route is final against machine writes.
 */
export function RouteReclassifyControl({
  engagementId,
  currentRoute,
  options,
}: {
  engagementId: string;
  currentRoute: string | null;
  options: Array<{ key: string; label: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [state, submit, submitting] = useActionState(reclassifyRouteAction, {
    error: null,
  } as ReclassifyRouteState);

  if (options.length === 0) return null;
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="cursor-pointer font-mono text-[10px] font-semibold tracking-wide text-accent uppercase hover:underline"
      >
        {currentRoute ? "reclassify" : "set route"}
      </button>
    );
  }
  return (
    <form action={submit} className="mt-1.5 flex flex-col gap-1.5">
      <input type="hidden" name="engagement_id" value={engagementId} />
      <select
        name="route"
        defaultValue={currentRoute ?? ""}
        required
        className="rounded-md border border-rule bg-paper px-2 py-1.5 text-[12.5px]"
      >
        <option value="" disabled>
          Choose a route…
        </option>
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
      <input
        name="reason"
        placeholder="Reason (optional) — e.g. caller actually needs ILR"
        className="rounded-md border border-rule bg-paper px-2 py-1.5 text-[12px]"
      />
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="cursor-pointer rounded-md bg-accent px-2.5 py-1 font-mono text-[10px] font-semibold tracking-wide text-white uppercase disabled:opacity-60"
        >
          {submitting ? "saving…" : "save route"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="cursor-pointer font-mono text-[10px] tracking-wide text-ink-soft uppercase hover:underline"
        >
          cancel
        </button>
      </div>
      {state.error ? <span className="text-[11.5px] text-stamp">{state.error}</span> : null}
      {state.saved ? (
        <span className="font-mono text-[10px] tracking-wide text-ledger uppercase">
          route saved — evented on The Record
        </span>
      ) : null}
    </form>
  );
}
