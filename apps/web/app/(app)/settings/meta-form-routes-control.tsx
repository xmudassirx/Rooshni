"use client";

import { useActionState } from "react";

import type { MetaFormRoutesState } from "@/lib/server/queries";
import { setMetaFormRouteAction, type MetaFormRoutesActionState } from "./actions";

/*
 * Session 27 (D161a): per-form default route mapping — under the Meta row,
 * the one door. A form with no route question ingests its default at lead
 * arrival (provenance form_default, the ladder's floor: Light and humans
 * outrank it). The route list renders FROM the declared vocabulary.
 */
export function MetaFormRoutesControl({ state }: { state: MetaFormRoutesState }) {
  const [result, submit, submitting] = useActionState(setMetaFormRouteAction, {
    error: null,
  } as MetaFormRoutesActionState);

  return (
    <div className="mt-3 border-t border-dashed border-rule pt-3">
      <div className="mb-1.5 font-mono text-[10px] font-semibold tracking-[.12em] text-ink-soft uppercase">
        Per-form default route · a form with no route question ingests its default
      </div>
      {state.rows.length ? (
        <div className="mb-2 flex flex-col gap-1">
          {state.rows.map((row) => (
            <div key={row.formId} className="flex flex-wrap items-center gap-2 text-[12px]">
              <span className="font-mono text-[11px] text-ink">
                {row.label ? `${row.label} · ` : ""}form {row.formId}
              </span>
              <span className="text-ink-faint">→</span>
              <span className="font-semibold">
                {state.routeOptions.find((o) => o.key === row.route)?.label ?? row.route}
              </span>
              <span className="font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">
                provenance: form default
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="mb-2 font-mono text-[10px] tracking-wide text-ink-faint uppercase">
          No form mappings yet
        </div>
      )}
      <form action={submit} className="flex flex-wrap items-center gap-2">
        <input
          name="form_id"
          placeholder="Form id (digits)"
          className="w-40 rounded-md border border-rule bg-paper px-2 py-1.5 font-mono text-[11.5px]"
        />
        <input
          name="form_label"
          placeholder="Label (optional, e.g. Spouse Visa 23/04/2024)"
          className="w-64 rounded-md border border-rule bg-paper px-2 py-1.5 text-[12px]"
        />
        <select
          name="route"
          defaultValue=""
          className="rounded-md border border-rule bg-paper px-2 py-1.5 text-[12px]"
        >
          <option value="">No default (remove)</option>
          {state.routeOptions.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={submitting}
          className="cursor-pointer rounded-md bg-accent px-2.5 py-1.5 font-mono text-[10px] font-semibold tracking-wide text-white uppercase disabled:opacity-60"
        >
          {submitting ? "saving…" : "save mapping"}
        </button>
      </form>
      {result.error ? <div className="mt-1 text-[11.5px] text-stamp">{result.error}</div> : null}
      {result.saved ? (
        <div className="mt-1 font-mono text-[10px] tracking-wide text-ledger uppercase">
          saved — evented on The Record
        </div>
      ) : null}
    </div>
  );
}
