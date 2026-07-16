"use client";

import { useState } from "react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { dayKey, formatDayHeading, formatTime } from "@/lib/format";
import { costLabel, describeEvent } from "@/lib/record-language";
import type { RecordEvent } from "@/lib/server/queries";
import { cn } from "@/lib/utils";

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

/** Where this entry leads when clicked — the ledger links back into the faces. */
function eventHref(event: RecordEvent): string | null {
  if (event.entityType === "engagement" && event.entityId) return `/enquiries/${event.entityId}`;
  if (event.entityType === "contact" && event.entityId) return `/contacts/${event.entityId}`;
  const engagementId = event.payload.engagement_id;
  if (typeof engagementId === "string") return `/enquiries/${engagementId}`;
  return null;
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
  const href = eventHref(event);
  const cost = costLabel(event.cost);
  const inner = (
    <>
      <span className="font-mono text-[10.5px] text-ink-faint">{formatTime(event.occurredAt)}</span>
      <span className="min-w-0 text-[13px]">
        <span className="font-mono text-[10px] tracking-wide text-accent">{event.action}</span>
        <span className="text-ink-soft"> — {describeEvent(event.action, event.payload)}</span>
      </span>
      <span className="flex items-center gap-2 justify-self-end">
        {cost ? <span className="light-text font-mono text-[10px]">{cost}</span> : null}
        <ActorTag event={event} />
      </span>
    </>
  );
  const rowClass =
    "grid grid-cols-[86px_1fr_auto] items-baseline gap-2.5 border-b border-rule px-3.5 py-2.5 last:border-b-0 max-[640px]:grid-cols-[minmax(0,1fr)_auto]";
  if (href) {
    return (
      <Link href={href} className={cn(rowClass, "transition-colors hover:bg-paper-deep")}>
        {inner}
      </Link>
    );
  }
  return <div className={rowClass}>{inner}</div>;
}

export function RecordList({ events }: { events: RecordEvent[] }) {
  const [filter, setFilter] = useState<ActorFilter>("all");
  const visible = events.filter((e) => matchesFilter(e, filter));

  // Newest first, bucketed per calendar day (Europe/London).
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
              "rounded-full border px-3 py-1 font-mono text-[11px] font-semibold tracking-wide uppercase transition-colors",
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
        <section key={day.heading} className="glass mb-3.5 overflow-hidden rounded-xl">
          <h2 className="border-b border-rule px-3.5 py-3 font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-soft uppercase">
            {day.heading}
          </h2>
          {day.rows.map((event) => (
            <Row key={event.id} event={event} />
          ))}
        </section>
      ))}

      {visible.length === 0 ? (
        <div className="glass rounded-xl border-dashed p-8 text-center font-mono text-xs tracking-wide text-ink-faint uppercase">
          Nothing on the Record for this filter yet
        </div>
      ) : null}
    </>
  );
}
