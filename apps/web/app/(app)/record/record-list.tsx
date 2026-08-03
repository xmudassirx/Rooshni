"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import { ChevronDown } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { dayKey, formatDayHeading, formatTime } from "@/lib/format";
import { costLabel, describeEvent } from "@/lib/record-language";
import { recordRowTarget } from "@/lib/record-row";
import type {
  RecordCursor,
  RecordEntityType,
  RecordEvent,
} from "@/lib/server/queries";
import { cn } from "@/lib/utils";
import { loadOlderRecordAction } from "./actions";

/*
 * Session 23 (WS3 — the s22 5b deferral, decision 157): reverse-chronological
 * infinite scroll, day-anchored, no page numbers. Each fetch is one bounded
 * window (RECORD_WINDOW); the day sections anchor here in the renderer and
 * MERGE across window edges, so a day split by a window boundary still reads
 * as one section. And a usable phone layout: below 640px each entry stacks —
 * time · kind · actor chip on the meta line, the plain-English line beneath —
 * replacing the overlapping grid the founder screenshotted.
 */

type ActorFilter = "all" | "human" | "light" | "integration";

const FILTERS: { key: ActorFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "human", label: "Humans" },
  { key: "light", label: "Light" },
  { key: "integration", label: "Integrations" },
];

function matchesFilter(event: RecordEvent, filter: ActorFilter): boolean {
  if (filter === "all") return true;
  if (filter === "human") return event.actorType === "human";
  if (filter === "light") return event.actorType === "agent";
  return event.actorType === "integration" || event.actorType === "workflow";
}

function ActorTag({ event }: { event: RecordEvent }) {
  if (event.actorType === "human") {
    return <Badge variant="red">{event.actorName}</Badge>;
  }
  if (event.actorType === "agent") {
    return <Badge variant="gold">✦ {event.actorName}</Badge>;
  }
  return <Badge variant="source">{event.actorName}</Badge>;
}

function Row({ event }: { event: RecordEvent }) {
  /* Session 26 (C1, founder-ordered): the row's click target expands the
   * entry in place; navigation is the labelled button INSIDE the expanded
   * register — "Open enquiry" is never the row's own click target.
   * JUDGMENT: no mockup drew an expanded row — the expansion shows the
   * entry's register facts (recorded instant, entry id, concerned entity,
   * cost, the payload verbatim in mono) in the ledger's own face; approved
   * by the founder in the Session 26 go message, recorded at close. */
  const [open, setOpen] = useState(false);
  const target = recordRowTarget(event);
  const cost = costLabel(event.cost);
  const payloadKeys = Object.keys(event.payload);
  const inner = (
    <>
      {/* Desktop: the three-column register (unchanged). */}
      <span className="font-mono text-[10.5px] text-ink-faint max-[640px]:hidden">
        {formatTime(event.occurredAt)}
      </span>
      <span className="min-w-0 text-[13px] max-[640px]:hidden">
        <span className="font-mono text-[10px] tracking-wide text-accent">{event.action}</span>
        <span className="text-ink-soft"> — {describeEvent(event.action, event.payload)}</span>
      </span>
      <span className="flex items-center gap-2 justify-self-end max-[640px]:hidden">
        {cost ? <span className="light-text font-mono text-[10px]">{cost}</span> : null}
        <ActorTag event={event} />
      </span>
      {/* Phone (WS3): the deliberate stacked row — time · kind · actor chip
          on the meta line, the plain-English words beneath; wraps, never
          overlaps. */}
      <span className="hidden w-full flex-wrap items-center gap-x-2 gap-y-1 max-[640px]:flex">
        <span className="font-mono text-[10px] text-ink-faint">{formatTime(event.occurredAt)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[9.5px] tracking-wide text-accent">
          {event.action}
        </span>
        {cost ? <span className="light-text font-mono text-[10px]">{cost}</span> : null}
        <ActorTag event={event} />
      </span>
      <span className="hidden text-[12.5px] leading-normal text-ink-soft max-[640px]:block">
        {describeEvent(event.action, event.payload)}
      </span>
    </>
  );
  const rowClass =
    "grid w-full grid-cols-[86px_1fr_auto_14px] items-baseline gap-2.5 px-3.5 py-2.5 text-left max-[640px]:flex max-[640px]:flex-col max-[640px]:gap-1";
  return (
    <div className="border-b border-rule last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(rowClass, "cursor-pointer transition-colors hover:bg-paper-deep")}
      >
        {inner}
        <ChevronDown
          aria-hidden
          className={cn(
            "size-3.5 self-center justify-self-end text-ink-faint transition-transform max-[640px]:hidden",
            open && "rotate-180"
          )}
        />
      </button>
      {open ? (
        <div className="border-t border-dashed border-rule bg-paper-deep/60 px-3.5 py-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-[10.5px] text-ink-soft">
            <dt className="tracking-wide text-ink-faint uppercase">Recorded</dt>
            <dd className="min-w-0 break-all">{event.occurredAt}</dd>
            <dt className="tracking-wide text-ink-faint uppercase">Entry</dt>
            <dd className="min-w-0 break-all">{event.id}</dd>
            {event.entityType ? (
              <>
                <dt className="tracking-wide text-ink-faint uppercase">Concerns</dt>
                <dd className="min-w-0 break-all">
                  {event.entityType}
                  {event.entityId ? ` · ${event.entityId}` : ""}
                </dd>
              </>
            ) : null}
            {cost ? (
              <>
                <dt className="tracking-wide text-ink-faint uppercase">Cost</dt>
                <dd className="light-text">{cost}</dd>
              </>
            ) : null}
          </dl>
          {payloadKeys.length > 0 ? (
            <pre className="mt-2.5 max-h-56 overflow-auto rounded-lg border border-rule bg-paper px-3 py-2.5 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-ink-soft">
              {JSON.stringify(event.payload, null, 2)}
            </pre>
          ) : null}
          {target ? (
            <div className="mt-3">
              <Button asChild size="sm">
                <Link href={target.href}>{target.label}</Link>
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function RecordList({
  initialEvents,
  initialHasMore,
  initialCursor,
  filter: entityFilter,
}: {
  initialEvents: RecordEvent[];
  initialHasMore: boolean;
  initialCursor: RecordCursor | null;
  filter: { entityType: RecordEntityType; entityId: string } | null;
}) {
  const [filter, setFilter] = useState<ActorFilter>("all");
  const [older, setOlder] = useState<RecordEvent[]>([]);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [cursor, setCursor] = useState<RecordCursor | null>(initialCursor);
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // A server re-render (Realtime doorbell, filter change) resets the scroll
  // accumulation; ids the fresh head now carries are deduped out.
  useEffect(() => {
    setOlder([]);
    setHasMore(initialHasMore);
    setCursor(initialCursor);
  }, [initialEvents, initialHasMore, initialCursor]);

  const events = useMemo(() => {
    const headIds = new Set(initialEvents.map((e) => e.id));
    return [...initialEvents, ...older.filter((e) => !headIds.has(e.id))];
  }, [initialEvents, older]);

  // The infinite scroll: a sentinel below the list fetches the next bounded
  // window when it comes into view.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      if (loadingRef.current || !cursor) return;
      loadingRef.current = true;
      setLoading(true);
      void loadOlderRecordAction(entityFilter, cursor)
        .then((window) => {
          setOlder((prev) => [...prev, ...window.events]);
          setHasMore(window.hasMore);
          setCursor(window.nextCursor);
        })
        .finally(() => {
          loadingRef.current = false;
          setLoading(false);
        });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, cursor, entityFilter]);

  const visible = events.filter((e) => matchesFilter(e, filter));

  // Newest first, bucketed per calendar day (Europe/London) — the anchor
  // sections merge across window edges by construction.
  const days: { key: string; heading: string; rows: RecordEvent[] }[] = [];
  for (const event of visible) {
    const key = dayKey(event.occurredAt);
    const last = days[days.length - 1];
    if (last && last.key === key) {
      last.rows.push(event);
    } else {
      days.push({ key, heading: formatDayHeading(event.occurredAt), rows: [event] });
    }
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={cn(
              "min-h-9 rounded-full border px-3 py-1 font-mono text-[11px] font-semibold tracking-wide uppercase transition-colors",
              filter === f.key
                ? "border-ink bg-ink text-paper"
                : "glass border-rule text-ink-soft hover:border-accent"
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {days.map((day) => (
        <section key={day.key} className="glass mb-3.5 overflow-hidden rounded-xl">
          <h2 className="border-b border-rule px-3.5 py-3 font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-soft uppercase">
            {day.heading}
          </h2>
          {day.rows.map((event) => (
            <Row key={event.id} event={event} />
          ))}
        </section>
      ))}

      {visible.length === 0 && !hasMore ? (
        <div className="glass rounded-xl border-dashed p-8 text-center font-mono text-xs tracking-wide text-ink-faint uppercase">
          Nothing on the Record for this filter yet
        </div>
      ) : null}

      {/* The scroll sentinel — honest about state either way. */}
      <div ref={sentinelRef} className="py-2 text-center font-mono text-[10px] tracking-wide text-ink-faint uppercase">
        {loading
          ? "reading further back…"
          : hasMore
            ? "scroll for older entries"
            : visible.length > 0
              ? "the beginning of The Record"
              : null}
      </div>
    </>
  );
}
