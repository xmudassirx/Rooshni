"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { setMailProviderAction, type MailProviderActionState } from "./actions";
import type { MailPipeState } from "@/lib/server/queries";

/*
 * Session 20 — the mail-pipe choice inside the Integrations mail row (one
 * door, decision 58). Two providers, one selection; the save is owner-gated
 * server-side and the wiring state below each option is read, never
 * invented: carrier configured = the env booleans, inbound bound = the
 * wire-inbound mailbox on settings. ACCENT carries the selection chrome
 * (decision 61); green stays connection-done only.
 */

const INITIAL: MailProviderActionState = { error: null };

const OPTIONS: { key: "graph" | "gmail"; name: string; meta: string }[] = [
  { key: "graph", name: "Microsoft 365", meta: "Microsoft Graph · sends as the firm's mailbox" },
  { key: "gmail", name: "Google Workspace", meta: "Gmail API · sends as the firm's mailbox" },
];

export function MailProviderControl({ pipe }: { pipe: MailPipeState }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(setMailProviderAction, INITIAL);

  useEffect(() => {
    if (state.saved) router.refresh();
  }, [state.saved, router]);

  return (
    <div className="mt-2.5">
      <div className="mb-1 font-mono text-[9.5px] font-semibold tracking-[.14em] text-ink-faint uppercase">
        Mail provider · per business
      </div>
      <div className="flex flex-col gap-1.5 sm:flex-row">
        {OPTIONS.map((option) => {
          const selected = pipe.provider === option.key;
          const wiring = pipe[option.key];
          return (
            <form key={option.key} action={formAction} className="flex-1">
              <input type="hidden" name="mail_provider" value={option.key} />
              <button
                type="submit"
                disabled={pending || !pipe.isOwner || selected}
                aria-pressed={selected}
                className={`w-full rounded-xl border-[1.5px] px-3 py-2.5 text-left transition-colors disabled:cursor-default ${
                  selected
                    ? "border-accent bg-accent/8"
                    : "border-rule bg-paper hover:border-accent/50 disabled:opacity-70"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-bold text-ink">{option.name}</span>
                  {selected ? (
                    <span className="rounded-md border border-accent/40 bg-accent/10 px-1.5 py-0.5 font-mono text-[9px] tracking-wide text-accent uppercase">
                      selected
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 text-[11px] text-ink-soft">{option.meta}</div>
                <div className="mt-1.5 font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">
                  {wiring.carrierConfigured ? "carrier configured" : "carrier not configured"}
                  {" · "}
                  {wiring.mailbox ? `inbound: ${wiring.mailbox}` : "inbound not bound"}
                </div>
              </button>
            </form>
          );
        })}
      </div>
      {!pipe.isOwner ? (
        <p className="mt-1.5 text-[11px] text-ink-faint">
          The mail pipe is the owner&apos;s pen — shown here so the state is one truth for everyone.
        </p>
      ) : null}
      {state.error ? <p className="mt-1.5 text-[12px] text-stamp">{state.error}</p> : null}
      {pending ? (
        <p className="mt-1.5 text-[11px] text-ink-faint">Saving…</p>
      ) : null}
      <ExplainerLine />
    </div>
  );
}

function ExplainerLine() {
  return (
    <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
      Selection is absolute: this business&apos;s email leaves only through the provider chosen here,
      never the other. Credentials and the inbound mailbox binding are wiring steps outside this
      screen; until they exist, stamped mail waits visibly rather than sending another way.
    </p>
  );
}
