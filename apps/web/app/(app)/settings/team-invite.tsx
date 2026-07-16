"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/*
 * The invite flow's UI (Session 8). Sending a real invite writes to the
 * allowlist — a protected auth structure — and wires with its own session;
 * submitting here says so plainly and writes nothing.
 */

const PRESETS = ["Caseworker", "Reception", "Admin"] as const;

export function InviteButton() {
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<(typeof PRESETS)[number]>("Caseworker");
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <>
      <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
        + Invite
      </Button>
      {notice ? (
        <span className="fixed bottom-5 left-1/2 z-100 w-max max-w-[92vw] -translate-x-1/2 rounded-lg bg-ink px-4 py-2.5 text-center text-[13px] font-normal text-paper shadow-[0_10px_30px_rgba(0,0,0,.3)]">
          {notice}
        </span>
      ) : null}
      {open ? (
        <>
          <button
            type="button"
            aria-label="Close"
            className="fixed inset-0 z-90 bg-ink/40 backdrop-blur-xs"
            onClick={() => setOpen(false)}
          />
          <div
            role="dialog"
            aria-label="Invite a member"
            className="glass fixed top-1/2 left-1/2 z-91 w-[min(480px,93vw)] -translate-x-1/2 -translate-y-1/2 rounded-[28px] text-left font-normal normal-case shadow-[0_24px_80px_rgba(32,43,56,.22)]"
          >
            <div className="px-6 pt-4 font-mono text-[9.5px] font-bold tracking-[.16em] text-ink-faint uppercase">
              Invite a member · sign-in stays behind the allowlist door
            </div>
            <div className="px-6 pt-3 pb-1">
              <input
                autoFocus
                type="email"
                placeholder="name@firm.co.uk"
                className="w-full rounded-xl border-[1.5px] border-rule bg-paper px-3.5 py-2.5 text-[14px] text-ink outline-none focus:border-accent"
              />
              <div className="mt-2.5 flex items-center gap-2">
                <span className="font-mono text-[9.5px] font-semibold tracking-[.14em] text-ink-faint uppercase">
                  Preset
                </span>
                {PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPreset(p)}
                    className={cn(
                      "rounded-2xl border px-3 py-1 font-mono text-[10.5px] font-semibold",
                      preset === p
                        ? "border-accent bg-accent text-white"
                        : "border-rule bg-panel text-ink-soft"
                    )}
                  >
                    {p}
                  </button>
                ))}
              </div>
              <p className="mt-2.5 text-[12px] leading-normal text-ink-soft">
                A preset is a starting bundle of grants — every one editable on
                their member page afterwards, every flip a row on The Record.
              </p>
            </div>
            <div className="flex px-4.5 py-3.5">
              <Button
                variant="primary"
                className="ml-auto"
                onClick={() => {
                  setOpen(false);
                  setNotice(
                    "Invites write to the allowlist — a protected auth structure that wires with its own session. Nothing was sent, nothing was written."
                  );
                  window.setTimeout(() => setNotice(null), 4200);
                }}
              >
                Send invite
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
