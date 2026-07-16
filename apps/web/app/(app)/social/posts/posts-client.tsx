"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";

const FILTERS = ["All", "Published", "✦ Pending", "Scheduled", "Drafts"] as const;

export function PostsFilters() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("All");
  return (
    <div className="mb-3.5 flex flex-wrap items-center gap-2">
      {FILTERS.map((f) => (
        <button
          key={f}
          type="button"
          onClick={() => setFilter(f)}
          className={cn(
            "rounded-2xl border px-3 py-1 font-mono text-[11px] font-semibold tracking-wide uppercase",
            filter === f ? "border-ink bg-ink text-paper" : "border-rule bg-panel text-ink-soft"
          )}
        >
          {f}
        </button>
      ))}
    </div>
  );
}
