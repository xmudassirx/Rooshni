"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { WebsitePageRow } from "@/lib/server/queries";
import { cn } from "@/lib/utils";

/*
 * view-website, master mockup v2: filter pills over content state, the pages
 * table (Page / State / Scorecard / Traffic 30d) and the new-page archetype
 * modal. Scorecards and traffic have no backing store yet — those cells say
 * so; they never invent a number.
 */

const FILTERS = [
  { key: "all", label: "All" },
  { key: "published", label: "Published" },
  { key: "draft", label: "Drafts" },
  { key: "pending_approval", label: "✦ Pending stamp" },
] as const;

const ARCHETYPES = [
  {
    icon: "▢",
    name: "Standard page",
    desc: "Service or info page. Schema: LegalService + Breadcrumb.",
  },
  { icon: "✎", name: "Blog post", desc: "Authority content. Schema: Article + FAQPage." },
  {
    icon: "◆",
    name: "Funnel page",
    desc: "Landing → capture → optional payment step. The skill from your own prompt doc.",
  },
  {
    icon: "⇩",
    name: "Web form",
    desc: "Standalone or embedded in any page. A lead source beside Meta.",
  },
  {
    icon: "◉",
    name: "Trust page",
    desc: "About / team / accreditations. Schema: Person per profile.",
  },
] as const;

function StateBadge({ state, byLight }: { state: string; byLight: boolean }) {
  if (state === "published") {
    return (
      <span className="rounded bg-ledger px-1.5 py-0.5 font-mono text-[9.5px] font-bold tracking-wide text-white uppercase">
        Published
      </span>
    );
  }
  if (state === "pending_approval") {
    return (
      <span className="light-chip rounded px-1.5 py-0.5 font-mono text-[9.5px] font-bold tracking-wide uppercase">
        ✦ Pending stamp
      </span>
    );
  }
  return (
    <span className="rounded border border-rule bg-paper-deep px-1.5 py-0.5 font-mono text-[9.5px] font-bold tracking-wide text-ink-soft uppercase">
      {state === "unpublished" ? "Unpublished" : byLight ? "✦ Draft" : "Draft"}
    </span>
  );
}

export function WebsiteClient({ pages }: { pages: WebsitePageRow[] }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  const [query, setQuery] = useState("");
  const [modal, setModal] = useState(false);
  const [lightBrief, setLightBrief] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [perPage, setPerPage] = useState(10);
  const [page, setPage] = useState(1);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of pages) map.set(p.state, (map.get(p.state) ?? 0) + 1);
    return map;
  }, [pages]);

  const visible = useMemo(
    () =>
      pages.filter(
        (p) =>
          (filter === "all" || p.state === filter) &&
          (!query.trim() ||
            p.title.toLowerCase().includes(query.trim().toLowerCase()) ||
            p.slug.includes(query.trim().toLowerCase()))
      ),
    [pages, filter, query]
  );

  const pageCount = Math.max(1, Math.ceil(visible.length / perPage));
  const current = Math.min(page, pageCount);
  const slice = visible.slice((current - 1) * perPage, current * perPage);

  return (
    <>
      <div className="mb-3.5 flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={cn(
              "rounded-2xl border px-3 py-1 font-mono text-[11px] font-semibold tracking-wide uppercase",
              filter === f.key
                ? "border-ink bg-ink text-paper"
                : "border-rule bg-panel text-ink-soft"
            )}
          >
            {f.label}{" "}
            <span className="opacity-65">
              {f.key === "all" ? pages.length : (counts.get(f.key) ?? 0)}
            </span>
          </button>
        ))}
        <label className="ml-auto flex min-w-[200px] items-center gap-2 rounded-2xl border border-rule bg-panel px-3.5 py-1.5 text-[13px] text-ink-faint shadow-panel">
          <Search className="size-3.5" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages…"
            className="w-full bg-transparent text-ink outline-none placeholder:text-ink-faint"
          />
        </label>
        <Button variant="primary" onClick={() => setModal(true)}>
          + New page
        </Button>
      </div>
      {notice ? (
        <p className="mb-2.5 font-mono text-[10.5px] tracking-wide text-amber uppercase">
          {notice}
        </p>
      ) : null}

      <div className="glass overflow-hidden rounded-xl">
        <h2 className="border-b border-rule bg-paper px-4 py-3 font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-soft uppercase">
          Pages · views over content_items · scorecards cached, history on The Record
        </h2>
        <div className="grid grid-cols-[1fr_130px_210px_120px] gap-3 border-b border-rule bg-accent-tint px-4 py-2.5 font-mono text-[9.5px] font-semibold tracking-[.14em] text-accent uppercase max-[760px]:grid-cols-[1fr_110px]">
          <span>Page</span>
          <span>State</span>
          <span className="max-[760px]:hidden">Scorecard</span>
          <span className="max-[760px]:hidden">Traffic 30d</span>
        </div>
        {visible.length ? (
          slice.map((p) => (
            <Link
              key={p.id}
              href={`/website/${p.id}`}
              className="grid grid-cols-[1fr_130px_210px_120px] items-center gap-3 border-b border-rule px-4 py-3 text-[13px] last:border-b-0 hover:bg-paper-deep max-[760px]:grid-cols-[1fr_110px]"
            >
              <span>
                <span className="block text-[13.5px] font-bold">{p.title}</span>
                <small className="mt-px block font-mono text-[10px] text-ink-faint uppercase">
                  /{p.slug} · {p.contentType.replace(/_/g, " ")}
                  {p.draftedByLight ? " · ✦ Light" : ""} · v{p.version}
                </small>
              </span>
              <span>
                <StateBadge state={p.state} byLight={p.draftedByLight} />
              </span>
              <span className="font-mono text-[10px] text-ink-faint uppercase max-[760px]:hidden">
                Not yet scored — scoring arrives with its session
              </span>
              <span className="font-mono text-[11px] text-ink-faint max-[760px]:hidden">—</span>
            </Link>
          ))
        ) : (
          <div className="px-6 py-10 text-center">
            <h3 className="mb-1.5 font-display text-lg font-extrabold">
              {pages.length ? "No pages match" : "No pages yet"}
            </h3>
            {!pages.length ? (
              <p className="mx-auto max-w-[46ch] text-[13px] text-ink-soft">
                The site&rsquo;s pages are content_items — none exist yet, and an
                empty table is the truth. The first page arrives through + New
                page, and its publish is a Level 3 stamp.
              </p>
            ) : null}
          </div>
        )}
        {/* v2 pagefoot: rows-per-page, the range, and page buttons. */}
        <div className="flex flex-wrap items-center gap-4 border-t border-rule px-4 py-2.5">
          <label className="flex items-center gap-2 font-mono text-[10.5px] tracking-wide text-ink-faint uppercase">
            Rows per page
            <select
              value={perPage}
              onChange={(e) => {
                setPerPage(Number(e.target.value));
                setPage(1);
              }}
              className="rounded-md border border-rule bg-panel px-1.5 py-0.5 font-mono text-[11px] text-ink"
            >
              {[10, 20, 50].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <span className="font-mono text-[10.5px] tracking-wide text-ink-faint uppercase">
            {visible.length
              ? `${(current - 1) * perPage + 1}–${Math.min(current * perPage, visible.length)} of ${visible.length}`
              : "0 pages match"}
          </span>
          <span className="ml-auto inline-flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous page"
              disabled={current <= 1}
              onClick={() => setPage(current - 1)}
              className="glass h-7 min-w-7 rounded-md font-mono text-xs text-ink-soft disabled:opacity-35"
            >
              ‹
            </button>
            {Array.from({ length: pageCount }).map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setPage(i + 1)}
                className={cn(
                  "h-7 min-w-7 rounded-md border font-mono text-xs",
                  current === i + 1
                    ? "border-ink bg-ink text-paper"
                    : "glass text-ink-soft"
                )}
              >
                {i + 1}
              </button>
            ))}
            <button
              type="button"
              aria-label="Next page"
              disabled={current >= pageCount}
              onClick={() => setPage(current + 1)}
              className="glass h-7 min-w-7 rounded-md font-mono text-xs text-ink-soft disabled:opacity-35"
            >
              ›
            </button>
          </span>
        </div>
      </div>

      <p className="mt-3 font-mono text-xs text-ink-faint">
        SCHEMA (JSON-LD) IS ATTACHED BY ARCHETYPE, EDITABLE PER PAGE — WHAT SEARCH AND ANSWER
        ENGINES READ. ON-PAGE SCORING GENERATED (PHASE 2) · OFF-PAGE RANKINGS = CONNECTED
        (PHASE 3) · STORES/WEBINARS: DECLINED UNDER THE VERTICAL RULE.
      </p>

      {modal ? (
        <>
          <button
            type="button"
            aria-label="Close"
            className="fixed inset-0 z-90 bg-ink/40 backdrop-blur-xs"
            onClick={() => {
              setModal(false);
              setLightBrief(false);
            }}
          />
          <div
            role="dialog"
            aria-label="New page"
            className="glass fixed top-1/2 left-1/2 z-91 w-[min(680px,94vw)] -translate-x-1/2 -translate-y-1/2 rounded-[28px] shadow-[0_24px_80px_rgba(32,43,56,.22)]"
          >
            <div className="flex items-center gap-2 px-6 pt-4 font-mono text-[9.5px] font-bold tracking-[.16em] text-ink-faint uppercase">
              <span className="light-spark text-[13px]">✦</span>
              New page — pick a shape, or let Light pick it
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3 px-5 pt-4 pb-1.5">
              {ARCHETYPES.map((a) => (
                <button
                  key={a.name}
                  type="button"
                  className="glass rounded-lg p-3.5 text-left hover:border-accent"
                  onClick={() => {
                    setModal(false);
                    setNotice(
                      `${a.name} — the archetype and its drafting flow arrive with the website-content session; nothing was created.`
                    );
                  }}
                >
                  <div className="text-xl">{a.icon}</div>
                  <div className="mt-1.5 mb-1 text-[13.5px] font-bold">{a.name}</div>
                  <div className="text-[11.5px] leading-normal text-ink-soft">{a.desc}</div>
                </button>
              ))}
              <Link
                href="/website/templates"
                className="glass rounded-lg p-3.5 text-left hover:border-accent"
                onClick={() => setModal(false)}
              >
                <div className="text-xl">▤</div>
                <div className="mt-1.5 mb-1 text-[13.5px] font-bold">From a template</div>
                <div className="text-[11.5px] leading-normal text-ink-soft">
                  Browse the gallery — free and premium, shell-wide, filter by category.
                </div>
              </Link>
              <button
                type="button"
                className="light-panel rounded-lg border-dashed p-3.5 text-left"
                onClick={() => setLightBrief(true)}
              >
                <div className="light-text text-xl">✦</div>
                <div className="light-text mt-1.5 mb-1 text-[13.5px] font-bold">
                  Let Light decide
                </div>
                <div className="text-[11.5px] leading-normal text-ink-soft">
                  Describe what you&rsquo;re trying to make — Light picks the shape and schema
                  for SEO/GEO.
                </div>
              </button>
            </div>
            {lightBrief ? (
              <div className="px-5 pt-1 pb-2">
                <textarea
                  autoFocus
                  placeholder="e.g. “A page about spouse visa costs and our fees, people keep asking on the phone…”"
                  className="min-h-27 w-full resize-none rounded-2xl border-[1.5px] border-rule bg-paper px-4 py-3.5 text-[15px] leading-relaxed text-ink outline-none light-focus"
                />
                <div className="flex items-center py-2">
                  <button
                    type="button"
                    title="Speak"
                    aria-label="Speak"
                    className="flex size-10.5 items-center justify-center rounded-xl text-ink hover:bg-paper-deep"
                    onClick={() =>
                      setNotice("Voice input arrives with Light's chat session — nothing is listening yet.")
                    }
                  >
                    🎙
                  </button>
                  <button
                    type="button"
                    aria-label="Send to Light"
                    className="light-btn ml-auto flex h-11 w-18 items-center justify-center rounded-3xl text-lg"
                    onClick={() => {
                      setModal(false);
                      setLightBrief(false);
                      setNotice(
                        "Light's recommendation flow arrives with its wiring session — nothing was sent, nothing was drafted."
                      );
                    }}
                  >
                    ↑
                  </button>
                </div>
              </div>
            ) : (
              <div className="pb-5" />
            )}
          </div>
        </>
      ) : null}
    </>
  );
}
