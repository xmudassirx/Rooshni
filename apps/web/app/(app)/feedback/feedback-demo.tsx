"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

/*
 * The mockup's try-the-flow card: what a client sees when they tap the
 * thumbs in a campaign footer. It is explicitly a demonstration — the real
 * form lives as a page on the tenant's site (form archetype), and no
 * feedback store exists yet, so submitting records NOTHING and says so.
 */

export function FeedbackDemo() {
  const [stage, setStage] = useState<"ask" | "form" | null>("ask");
  const [up, setUp] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-center px-4 py-4.5">
      {stage === "ask" ? (
        <div className="w-full max-w-[380px] rounded-xl border-[1.5px] border-stamp bg-panel px-6 py-5 text-center">
          <div className="mb-3 font-display text-[17px] font-extrabold">
            Was this email useful?
          </div>
          <div className="flex justify-center gap-3.5">
            {(["👍", "👎"] as const).map((t, i) => (
              <button
                key={t}
                type="button"
                className="h-11 w-13 rounded-lg border border-rule bg-paper-deep text-[22px] hover:border-stamp"
                onClick={() => {
                  setUp(i === 0);
                  setStage("form");
                }}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      ) : stage === "form" ? (
        <div className="w-full max-w-[380px] rounded-xl border-[1.5px] border-stamp bg-panel px-6 py-5 text-center">
          <div className="mb-2 font-mono text-[8.5px] tracking-[.1em] text-ink-faint uppercase">
            ◈ /feedback · form page · writes into this surface
          </div>
          <div className="font-display text-[15px] font-extrabold">Got it, thanks!</div>
          <div className="mt-1 mb-3 text-sm">
            {up ? "What would you like to see more of?" : "What should we improve?"}
          </div>
          <input
            placeholder="Type your answer…"
            className="w-full rounded-lg border-[1.5px] border-rule bg-paper px-3 py-2.5 text-[13px] text-ink outline-none focus:border-accent"
          />
          <Button
            variant="primary"
            className="mt-2.5"
            onClick={() => {
              setStage("ask");
              setNotice(
                "A demonstration only — the feedback store arrives with its session; nothing was recorded."
              );
              window.setTimeout(() => setNotice(null), 3600);
            }}
          >
            Submit
          </Button>
        </div>
      ) : null}
      {notice ? (
        <p className="mt-3 font-mono text-[10.5px] tracking-wide text-amber uppercase">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
