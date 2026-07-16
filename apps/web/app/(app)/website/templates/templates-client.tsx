"use client";

import { useState } from "react";
import { Search } from "lucide-react";

import { HonestButton } from "@/components/ui/honest-button";
import { cn } from "@/lib/utils";

/*
 * view-wstemplates, master mockup v2: the shell-wide gallery — category
 * pills, search, free/premium cards, the MARKETPLACE SEED · PHASE 4 chip.
 * No template store exists yet, so the gallery renders its honest empty
 * state — never a fabricated card.
 */

const CATEGORIES = ["All", "Funnels", "Blog", "Trust", "Forms", "Full site"] as const;

export function TemplatesClient() {
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("All");
  const [query, setQuery] = useState("");

  return (
    <>
      <div className="mb-3.5 flex flex-wrap items-center gap-2">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCategory(c)}
            className={cn(
              "rounded-2xl border px-3 py-1 font-mono text-[11px] font-semibold tracking-wide uppercase",
              category === c ? "border-ink bg-ink text-paper" : "border-rule bg-panel text-ink-soft"
            )}
          >
            {c}
          </button>
        ))}
        <label className="ml-auto flex min-w-[200px] items-center gap-2 rounded-2xl border border-rule bg-panel px-3.5 py-1.5 text-[13px] text-ink-faint shadow-panel">
          <Search className="size-3.5" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search templates…"
            className="w-full bg-transparent text-ink outline-none placeholder:text-ink-faint"
          />
        </label>
      </div>

      <div className="glass rounded-2xl border-dashed p-9 text-center">
        <h2 className="mb-2 font-display text-xl font-extrabold">The gallery is empty</h2>
        <p className="mx-auto max-w-[50ch] text-sm text-ink-soft">
          Templates are shapes, not content — free and premium, shell-wide,
          yours and (in Phase 4) the marketplace&rsquo;s. No template store
          exists yet; the first shapes arrive with the website-content session,
          and adopting any of them is a stamped change.
        </p>
        <span className="mt-3 inline-block rounded-md border border-accent bg-accent-tint px-3 py-1 font-mono text-[11px] font-semibold tracking-wide text-accent uppercase">
          Website-content session
        </span>
      </div>

      <p className="mt-3 font-mono text-xs text-ink-faint">
        TEMPLATES ARE SHAPES, NOT CONTENT — YOUR KNOWLEDGE PACK AND TOKENS FILL THEM. PREMIUM
        BUYS PASS THE SPEND GATE. ADOPTING ANY TEMPLATE IS A STAMPED CHANGE.
      </p>
    </>
  );
}

export function TemplatesActions() {
  return (
    <>
      <span
        className="cursor-help self-center rounded border border-dashed border-stamp bg-stamp-tint px-2 py-0.5 font-mono text-[9.5px] font-bold tracking-[.1em] text-stamp uppercase"
        title="This gallery is the seed of the Phase 4 templates marketplace — free + premium, creators paid. Drawn now, monetised later."
      >
        Marketplace seed · Phase 4
      </span>
      <HonestButton
        variant="primary"
        notice="New template — the same three doors as a page: Write it · Code (HTML) · ✦ Ask Light. The template store arrives with the website-content session."
      >
        + New template
      </HonestButton>
    </>
  );
}
