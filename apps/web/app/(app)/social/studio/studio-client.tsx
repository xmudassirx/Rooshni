"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";

/*
 * view-sostudio, master mockup v2: image|video modes with mode-specific
 * providers (img: GPT Image, Imagen; vid: Flow/Veo, Higgsfield, Omni),
 * optional first frame on video, brand tokens riding along, a per-generation
 * spend gate. No provider is connected (connections live ONCE, in Settings →
 * Integrations) and no library exists — the panel says so.
 */

const PROVIDERS: Record<"img" | "vid", string[]> = {
  img: ["GPT Image", "Google Imagen"],
  vid: ["Google Flow (Veo)", "Higgsfield", "Omni"],
};

export function StudioClient() {
  const [mode, setMode] = useState<"img" | "vid">("img");
  const [notice, setNotice] = useState<string | null>(null);

  function say(text: string) {
    setNotice(text);
    window.setTimeout(() => setNotice(null), 4200);
  }

  return (
    <>
      {notice ? (
        <span className="fixed bottom-5 left-1/2 z-100 w-max max-w-[92vw] -translate-x-1/2 rounded-lg bg-ink px-4 py-2.5 text-center text-[13px] text-paper shadow-[0_10px_30px_rgba(0,0,0,.3)]">
          {notice}
        </span>
      ) : null}
      <div className="glass overflow-hidden rounded-xl">
        <h2 className="border-b border-rule bg-paper px-4 py-3 font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-soft uppercase">
          ✦ Create media · providers connect over MCP in Settings → Integrations · every
          generation passes the spend gate
        </h2>
        <div className="px-4 py-3.5">
          <div className="mb-2.5 flex flex-wrap items-center gap-2">
            {(["img", "vid"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn(
                  "rounded-2xl border px-3 py-1 font-mono text-[11px] font-semibold tracking-wide uppercase",
                  mode === m ? "border-ink bg-ink text-paper" : "border-rule bg-panel text-ink-soft"
                )}
              >
                {m === "img" ? "Image" : "Video"}
              </button>
            ))}
            {mode === "vid" ? (
              <button
                type="button"
                className="glass rounded-lg px-3 py-1.5 text-xs font-semibold"
                onClick={() =>
                  say(
                    "Optional first frame — upload or pick from the library; the provider animates from it. Consistency across a series comes from reusing the same frame."
                  )
                }
              >
                + First frame · optional
              </button>
            ) : null}
            <select
              className="rounded-md border border-rule bg-panel px-2 py-1.5 font-mono text-[11px] text-ink-faint"
              onChange={() =>
                say("Providers are integrations — connected once in Settings → Integrations; none is connected yet.")
              }
            >
              {PROVIDERS[mode].map((p) => (
                <option key={p}>{p} · connect…</option>
              ))}
            </select>
            <button
              type="button"
              className="rounded-md border border-rule bg-paper-deep px-2 py-1 font-mono text-[10px] font-semibold tracking-wide text-ink-soft uppercase"
              onClick={() =>
                say(
                  "Brand tokens ride along automatically — palette, fonts, image style from Site Identity. Off-brand output never reaches a post."
                )
              }
            >
              ◈ Brand tokens: on
            </button>
          </div>
          <textarea
            placeholder="Describe it — “warm photo-style image: reunited family at Manchester airport, no faces identifiable, space for headline top-left…”"
            className="min-h-19 w-full resize-none rounded-xl border-[1.5px] border-rule bg-paper px-4 py-3 text-[14px] leading-relaxed text-ink outline-none focus:border-accent"
          />
          <div className="mt-2.5 flex items-center gap-2.5">
            <span className="font-mono text-[9px] tracking-wide text-ink-faint uppercase">
              Cost estimates appear once a provider is connected · alt text is written in the
              same act
            </span>
            <button
              type="button"
              aria-label="Generate"
              className="light-btn ml-auto flex h-11 w-18 items-center justify-center rounded-3xl text-lg"
              onClick={() =>
                say(
                  "✦ No provider is connected — media models connect over MCP in Settings → Integrations, and every generation passes the spend gate. Nothing was generated, nothing was spent."
                )
              }
            >
              ↑
            </button>
          </div>
        </div>
      </div>

      <div className="glass mt-4 overflow-hidden rounded-xl">
        <h2 className="border-b border-rule bg-paper px-4 py-3 font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-soft uppercase">
          Library · files table · provenance on every asset
        </h2>
        <div className="px-6 py-10 text-center">
          <h3 className="mb-1.5 font-display text-lg font-extrabold">The library is empty</h3>
          <p className="mx-auto max-w-[50ch] text-[13px] text-ink-soft">
            Every asset arrives with its provenance — provider, prompt, cost —
            on The Record. Video is never our bytes: a poster frame lives here,
            the video streams from the provider&rsquo;s CDN, Meta hosts the
            published copy.
          </p>
        </div>
      </div>
    </>
  );
}
