"use client";

import { useRef, useState } from "react";
import { ArrowUp, Mic, Paperclip } from "lucide-react";

/**
 * The front-door composer. Light's chat wiring (routing, acts, threads) is a
 * later session — the composer is honest about that: nothing is sent, nothing
 * pretends to answer. The chips prefill, exactly as the mockup draws them.
 */

const CHIPS: { label: string; text: string }[] = [
  { label: "Plan my day", text: "Plan my day from the pipeline and my tasks" },
  {
    label: "Draft a chase",
    text: "Draft a chase email to Bilal's sponsor about the CoS date",
  },
  { label: "What changed today?", text: "What changed on The Record today?" },
  {
    label: "Fix a mistake",
    text: "Earlier I linked the call-prep note to the wrong enquiry — fix it",
  },
];

export function LightComposer() {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function say(text: string) {
    setNotice(text);
  }

  return (
    <>
      <div className="glass overflow-hidden rounded-3xl shadow-[0_18px_60px_rgba(32,43,56,.14)]">
        <textarea
          ref={taRef}
          className="min-h-24 w-full resize-none bg-transparent px-5.5 py-4.5 text-[15.5px] leading-relaxed text-ink outline-none placeholder:text-ink-faint"
          placeholder="e.g. “Today I need to call Ayesha about her payslips and send Bilal the checklist — set me up, and draft the checklist yourself.”"
        />
        <div className="flex items-center gap-1.5 border-t border-rule px-4 py-3.5">
          <button
            type="button"
            title="Attach"
            aria-label="Attach"
            className="flex size-10.5 items-center justify-center rounded-xl text-ink hover:bg-paper-deep"
            onClick={() =>
              say("Attachments ride the files table — wiring arrives with Light's chat session.")
            }
          >
            <Paperclip className="size-5" />
          </button>
          <button
            type="button"
            title="Speak"
            aria-label="Speak"
            className="flex size-10.5 items-center justify-center rounded-xl text-ink hover:bg-paper-deep"
            onClick={() =>
              say("Voice input arrives with Light's chat session — nothing is listening yet.")
            }
          >
            <Mic className="size-5" />
          </button>
          <button
            type="button"
            aria-label="Send to Light"
            className="light-btn ml-auto flex h-13 w-22 items-center justify-center rounded-[26px] shadow-[0_10px_26px_rgba(63,140,255,.35)]"
            onClick={() =>
              say(
                "Light's chat is a front door and its wiring is a later session — nothing was sent, nothing was recorded."
              )
            }
          >
            <ArrowUp className="size-5.5" strokeWidth={2.4} />
          </button>
        </div>
      </div>
      {notice ? (
        <p className="mt-3 text-center font-mono text-[10.5px] tracking-[.06em] text-ink-faint uppercase">
          {notice}
        </p>
      ) : null}
      <div className="mt-3.5 flex flex-wrap justify-center gap-2">
        {CHIPS.map((chip) => (
          <button
            key={chip.label}
            type="button"
            className="glass rounded-2xl px-3 py-1.5 font-mono text-[11px] font-semibold tracking-[.05em] text-ink-soft uppercase hover:border-accent"
            onClick={() => {
              if (taRef.current) taRef.current.value = chip.text;
              say("Prefilled — sending arrives with Light's chat session.");
            }}
          >
            {chip.label}
          </button>
        ))}
      </div>
    </>
  );
}
