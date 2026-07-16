"use client";

import { useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/*
 * Shared Social chrome — the Create-post composer and the Preferences modal,
 * exactly as pass 3 drew them (founder-ruled composition; function settled).
 * The social store, Meta publishing and Light's drafting are later sessions:
 * every submit says so plainly. Connections live ONCE, in Settings →
 * Integrations (decision 58) — the Preferences modal carries behaviour only.
 */

function Toast({ text }: { text: string }) {
  return (
    <span className="fixed bottom-5 left-1/2 z-100 w-max max-w-[92vw] -translate-x-1/2 rounded-lg bg-ink px-4 py-2.5 text-center text-[13px] text-paper shadow-[0_10px_30px_rgba(0,0,0,.3)]">
      {text}
    </span>
  );
}

function ChannelChip({
  label,
  on = false,
  disabled = false,
  title,
}: {
  label: string;
  on?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "rounded-2xl border px-3.5 py-1.5 font-mono text-[11px] font-semibold",
        disabled && "cursor-not-allowed opacity-45",
        on ? "border-accent bg-accent text-white" : "border-rule bg-panel text-ink-soft"
      )}
    >
      {label}
    </span>
  );
}

export function CreatePostButton() {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  function say(text: string) {
    setNotice(text);
    window.setTimeout(() => setNotice(null), 3600);
  }

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        + Create post
      </Button>
      {notice ? <Toast text={notice} /> : null}
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
            aria-label="Create post"
            className="glass fixed top-1/2 left-1/2 z-91 w-[min(640px,94vw)] -translate-x-1/2 -translate-y-1/2 rounded-[28px] shadow-[0_24px_80px_rgba(32,43,56,.22)]"
          >
            <div className="flex items-center gap-2 px-6 pt-4 font-mono text-[9.5px] font-bold tracking-[.16em] text-ink-faint uppercase">
              <span className="light-spark text-[13px]">✦</span> Create post
            </div>
            <div className="px-6 pt-2.5">
              <div className="mb-2.5 flex gap-2">
                <ChannelChip
                  label="Facebook"
                  title="No Meta connection yet — connections live in Settings → Integrations"
                />
                <ChannelChip
                  label="Instagram"
                  title="No Meta connection yet — connections live in Settings → Integrations"
                />
                <ChannelChip label="LinkedIn · P3" disabled title="Phase 3" />
              </div>
              <textarea
                placeholder="Say it — or let Light draft it to the social voice card…"
                className="min-h-27 w-full resize-none rounded-2xl border-[1.5px] border-rule bg-paper px-4 py-3.5 text-[15px] leading-relaxed text-ink outline-none focus:border-accent"
              />
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="gold"
                  onClick={() =>
                    say("✦ Light drafts to the social voice card — its wiring is a later session; nothing was drafted.")
                  }
                >
                  ✦ Draft with Light
                </Button>
                <Button
                  size="sm"
                  onClick={() => say("The Studio library is empty — media arrives with its session.")}
                >
                  ▣ Media · Studio
                </Button>
                <Button
                  size="sm"
                  onClick={() =>
                    say("✦ Generation rides connected providers and the spend gate — both arrive with their sessions.")
                  }
                >
                  ✦ Generate media
                </Button>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => say("The calendar picker — same control as Tasks; scheduling arrives with the social store.")}>
                  + day
                </Button>
                <Button size="sm" onClick={() => say("The clock picker — same control as Tasks; scheduling arrives with the social store.")}>
                  + time
                </Button>
                <span className="font-mono text-[10px] tracking-wide text-ink-faint uppercase">
                  ✦ Best-time suggestions appear once analytics events exist
                </span>
              </div>
              <p className="mt-2.5 font-mono text-[9px] tracking-[.05em] text-ink-faint uppercase">
                No_go scan runs on queue · publishing is Level 3 — a post joins the
                week&rsquo;s batch in your Approval Inbox
              </p>
            </div>
            <div className="flex items-center gap-1.5 px-4.5 py-3.5">
              <Button
                onClick={() => {
                  setOpen(false);
                  say("The social store arrives with its session — nothing was saved.");
                }}
              >
                Save draft
              </Button>
              <button
                type="button"
                aria-label="Queue for stamp"
                className="light-btn ml-auto flex h-11 w-18 items-center justify-center rounded-3xl text-lg"
                onClick={() => {
                  setOpen(false);
                  say("Queueing for the batch stamp arrives with the social store — nothing was queued.");
                }}
              >
                ↑
              </button>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}

export function PreferencesButton() {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <>
      <Button onClick={() => setOpen(true)}>Preferences</Button>
      {notice ? <Toast text={notice} /> : null}
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
            aria-label="Social preferences"
            className="glass fixed top-1/2 left-1/2 z-91 w-[min(520px,93vw)] -translate-x-1/2 -translate-y-1/2 rounded-[28px] shadow-[0_24px_80px_rgba(32,43,56,.22)]"
          >
            <div className="flex items-center gap-2 px-6 pt-4 font-mono text-[9.5px] font-bold tracking-[.16em] text-ink-faint uppercase">
              <span className="light-spark text-[13px]">✦</span>
              Social preferences · behaviour only — connections live in Settings → Integrations
            </div>
            <div className="flex flex-col px-6 py-3">
              {(
                [
                  ["Cadence", "3 posts / week — Light plans the calendar to this rhythm"],
                  ["Quiet days", "Sat · Sun — quiet weekends by preference"],
                  ["Default channels", "FB · IG — once Meta is connected"],
                  ["Batch stamp day", "Monday — the week's drafts arrive as one Inbox item"],
                ] as const
              ).map(([k, v]) => (
                <div
                  key={k}
                  className="grid grid-cols-[130px_1fr] items-baseline gap-4 border-b border-rule py-3 text-[13.5px]"
                >
                  <b>{k}</b>
                  <span className="text-[12.5px] text-ink-soft">{v}</span>
                </div>
              ))}
              <Link
                href="/settings"
                onClick={() => setOpen(false)}
                className="grid grid-cols-[130px_1fr] items-baseline gap-4 py-3 text-[13.5px] hover:bg-paper-deep"
              >
                <b>Connections</b>
                <span className="text-[12.5px] text-ink-soft">
                  → Settings / Integrations — Meta, media providers (MCP), one place
                </span>
              </Link>
              <p className="pt-1 pb-2 font-mono text-[10px] tracking-wide text-ink-faint uppercase">
                Preference storage arrives with the social store — these are the
                defaults it will carry.
              </p>
            </div>
            <div className="flex px-4.5 pb-3.5">
              <Button
                variant="primary"
                className="ml-auto"
                onClick={() => {
                  setOpen(false);
                  setNotice("Preference storage arrives with the social store — nothing was saved.");
                  window.setTimeout(() => setNotice(null), 3600);
                }}
              >
                Done
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
