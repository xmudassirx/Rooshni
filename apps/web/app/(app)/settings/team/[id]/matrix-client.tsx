"use client";

import { useState } from "react";

import type { MemberDetail } from "@/lib/server/queries";
import { cn } from "@/lib/utils";

/*
 * view-member's permission matrix, master mockup v2 — every cell reads the
 * REAL grants rows for this actor. Flipping a grant issues or revokes a row
 * in the permission engine (a protected structure); that write wires with
 * its own session, and tapping a cell says so — the matrix never pretends a
 * flip happened.
 */

const ACCESSES = ["view", "draft", "execute"] as const;

export function PermissionMatrix({ member }: { member: MemberDetail }) {
  const [notice, setNotice] = useState<string | null>(null);

  const granted = new Set(member.grants.map((g) => `${g.tool}:${g.access}`));

  function tap(tool: string, access: string) {
    const has = granted.has(`${tool}:${access}`);
    setNotice(
      has
        ? `“${tool} · ${access}” is a live grant row. Revoking wires with the grant-management session — nothing changed.`
        : `No grant for “${tool} · ${access}”. Issuing one wires with the grant-management session — nothing changed.`
    );
    window.setTimeout(() => setNotice(null), 4200);
  }

  return (
    <>
      {notice ? (
        <span className="fixed bottom-5 left-1/2 z-100 w-max max-w-[92vw] -translate-x-1/2 rounded-lg bg-ink px-4 py-2.5 text-center text-[13px] text-paper shadow-[0_10px_30px_rgba(0,0,0,.3)]">
          {notice}
        </span>
      ) : null}
      <div className="px-4 pt-1.5 pb-4">
        <div className="grid grid-cols-[minmax(120px,1.4fr)_56px_56px_56px_minmax(0,1fr)] items-center gap-2 border-b border-rule py-2 font-mono text-[9.5px] font-semibold tracking-[.12em] text-ink-faint uppercase">
          <span />
          <span>View</span>
          <span>Draft</span>
          <span>Execute</span>
          <span />
        </div>
        {member.tools.map((tool) => (
          <div
            key={tool.key}
            className="grid grid-cols-[minmax(120px,1.4fr)_56px_56px_56px_minmax(0,1fr)] items-center gap-2 border-b border-dashed border-rule py-2 last:border-b-0"
          >
            <span className="text-[13px] font-semibold">{tool.label}</span>
            {ACCESSES.map((access) => {
              const on = granted.has(`${tool.key}:${access}`);
              return (
                <button
                  key={access}
                  type="button"
                  aria-label={`${tool.label} — ${access}${on ? " granted" : " not granted"}`}
                  onClick={() => tap(tool.key, access)}
                  className={cn(
                    "h-6 w-10 rounded-xl border-[1.5px] text-xs transition-colors",
                    on
                      ? "border-ledger bg-ledger text-white"
                      : "border-rule bg-paper-deep text-transparent"
                  )}
                >
                  {on ? "✓" : ""}
                </button>
              );
            })}
            <span className="font-mono text-[9.5px] text-ink-faint">
              {tool.category === "approvals" ? "grantable to seniors; never to AI" : ""}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
