"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { setConversionsAction, type ConversionsActionState } from "./actions";
import type { ConversionsRowState } from "@/lib/server/queries";

/*
 * Session 22 (WS1, ruling 1d) — the Conversions row's control inside
 * Settings → Integrations (one door, decision 58). The toggle defaults OFF
 * and only the owner flips it; the dataset id and test event code live on
 * the same row; the wiring state below is read, never invented (token
 * presence as a boolean, the page binding by presence). ACCENT carries the
 * control chrome (decision 61); green stays connection-done only.
 */

const INITIAL: ConversionsActionState = { error: null };

export function ConversionsControl({ state: row }: { state: ConversionsRowState }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(setConversionsAction, INITIAL);

  useEffect(() => {
    if (state.saved) router.refresh();
  }, [state.saved, router]);

  return (
    <div className="mt-2.5">
      <div className="mb-1 font-mono text-[9.5px] font-semibold tracking-[.14em] text-ink-faint uppercase">
        Conversions · outcome events to Meta
      </div>
      <form action={formAction} className="rounded-xl border-[1.5px] border-rule bg-paper px-3 py-2.5">
        <label className="flex items-center gap-2.5">
          <input
            type="checkbox"
            name="conversions_enabled"
            defaultChecked={row.enabled}
            disabled={pending || !row.isOwner}
            className="size-4 accent-accent"
          />
          <span className="text-[13px] font-bold text-ink">
            Send outcome events to Meta
          </span>
          <span
            className={
              row.enabled
                ? "ml-auto rounded-md border border-accent/40 bg-accent/10 px-1.5 py-0.5 font-mono text-[9px] tracking-wide text-accent uppercase"
                : "ml-auto rounded-md border border-ink/15 bg-paper-deep px-1.5 py-0.5 font-mono text-[9px] tracking-wide text-ink-faint uppercase"
            }
          >
            {row.enabled ? "on" : "off"}
          </span>
        </label>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-soft">
          Consultation booked becomes a Schedule event; instructed becomes a Purchase (with the
          recorded fee only when an invoice exists). Junk teaches Meta nothing. Hashed email and
          phone only, never raw details; every send lands on The Record.
        </p>
        <div className="mt-2 grid grid-cols-2 gap-2 max-[560px]:grid-cols-1">
          <label className="block">
            <span className="font-mono text-[9.5px] tracking-[.12em] text-ink-faint uppercase">
              Dataset id (Events Manager)
            </span>
            <input
              type="text"
              name="dataset_id"
              defaultValue={row.datasetId ?? ""}
              placeholder="e.g. 1234567890"
              disabled={pending || !row.isOwner}
              inputMode="numeric"
              className="mt-0.5 w-full rounded-lg border border-rule bg-paper-deep px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
            />
          </label>
          <label className="block">
            <span className="font-mono text-[9.5px] tracking-[.12em] text-ink-faint uppercase">
              Test event code (optional)
            </span>
            <input
              type="text"
              name="test_event_code"
              defaultValue={row.testEventCode ?? ""}
              placeholder="TEST12345"
              disabled={pending || !row.isOwner}
              className="mt-0.5 w-full rounded-lg border border-rule bg-paper-deep px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
            />
          </label>
        </div>
        <div className="mt-2 flex items-center gap-2.5">
          <button
            type="submit"
            disabled={pending || !row.isOwner}
            className="rounded-lg border border-accent/50 bg-accent/10 px-3 py-1.5 text-[12px] font-bold text-accent transition-colors hover:bg-accent/15 disabled:cursor-default disabled:opacity-60"
          >
            {pending ? "Saving…" : "Save"}
          </button>
          <span className="font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">
            {row.tokenPresent ? "token configured" : "token not configured"}
            {" · "}
            {row.pageBound ? "lead page bound" : "lead page not bound"}
            {" · "}
            {row.datasetId ? "dataset set" : "dataset not set"}
          </span>
        </div>
        {!row.isOwner ? (
          <p className="mt-1.5 text-[11px] text-ink-faint">
            The Conversions switch is the owner&apos;s pen — shown here so the state is one truth
            for everyone.
          </p>
        ) : null}
        {state.error ? <p className="mt-1.5 text-[12px] text-stamp">{state.error}</p> : null}
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
          With a test event code set, events land in Events Manager&apos;s test stream and never
          pollute real reporting. The daily ad-spend pull rides the same switch; if the access
          token cannot read insights, the pull stands down visibly naming the missing scope.
        </p>
      </form>
    </div>
  );
}
