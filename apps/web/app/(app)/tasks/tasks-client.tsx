"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatTime } from "@/lib/format";
import type { EnquiryOption, TaskRow } from "@/lib/server/queries";
import { cn } from "@/lib/utils";

import {
  handToLightAction,
  saveTaskAction,
  setTaskStatusAction,
  type TaskActionState,
} from "./actions";

/*
 * view-tasks, master mockup v2: the week with strict columns
 * (task | TIME | HAND-OFF), collapsible days, quiet weekends, the month grid,
 * and the task modal with view/edit modes, any-month calendar popover,
 * alarm-style HH:MM picker and search-filtered enquiry link.
 *
 * JUDGMENT: the static mockup draws one fixed week; reaching other weeks needs
 * navigation, so the header gains ‹ › week arrows (the month grid's tap-through
 * is the other route in) — Lane B, listed for sign-off.
 */

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function startOfWeek(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const shift = (out.getDay() + 6) % 7;
  out.setDate(out.getDate() - shift);
  return out;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

interface ModalState {
  open: boolean;
  editing: boolean;
  id: string | null;
  title: string;
  description: string;
  day: { y: number; m: number; d: number };
  time: string; // "HH:MM" or "" for no time
  enquiryId: string;
  enquiryLabel: string;
}

function emptyModal(day: Date): ModalState {
  return {
    open: true,
    editing: true,
    id: null,
    title: "",
    description: "",
    day: { y: day.getFullYear(), m: day.getMonth(), d: day.getDate() },
    time: "",
    enquiryId: "",
    enquiryLabel: "",
  };
}

export function TasksClient({
  tasks,
  enquiries,
  agent,
}: {
  tasks: TaskRow[];
  enquiries: EnquiryOption[];
  agent: { id: string; name: string } | null;
}) {
  const today = new Date();
  const [view, setView] = useState<"week" | "month">("week");
  const [weekStart, setWeekStart] = useState(() => startOfWeek(today));
  const [monthAnchor, setMonthAnchor] = useState(
    () => new Date(today.getFullYear(), today.getMonth(), 1)
  );
  const [openDays, setOpenDays] = useState<Set<string>>(
    () => new Set([today.toDateString()])
  );
  const [modal, setModal] = useState<ModalState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const byDay = useMemo(() => {
    const map = new Map<string, TaskRow[]>();
    for (const t of tasks) {
      if (!t.dueAt) continue;
      const key = new Date(t.dueAt).toDateString();
      const list = map.get(key) ?? [];
      list.push(t);
      map.set(key, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));
    }
    return map;
  }, [tasks]);

  const undated = tasks.filter((t) => !t.dueAt);

  function run(action: (prev: TaskActionState, fd: FormData) => Promise<TaskActionState>, fields: Record<string, string>) {
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.set(k, v);
      const result = await action({ error: null }, fd);
      if (result.error) setError(result.error);
      else setModal(null);
    });
  }

  function openTask(t: TaskRow) {
    const due = t.dueAt ? new Date(t.dueAt) : today;
    setModal({
      open: true,
      editing: false,
      id: t.id,
      title: t.title,
      description: t.description ?? "",
      day: { y: due.getFullYear(), m: due.getMonth(), d: due.getDate() },
      time: t.dueAt && !t.allDay ? formatTime(t.dueAt).slice(0, 5) : "",
      enquiryId: t.enquiry?.id ?? "",
      enquiryLabel: t.enquiry?.title ?? "",
    });
  }

  function saveModal(assigneeAgentId?: string) {
    if (!modal) return;
    const [hh = 0, mm = 0] = modal.time ? modal.time.split(":").map(Number) : [];
    const due = new Date(modal.day.y, modal.day.m, modal.day.d, hh, mm);
    run(saveTaskAction, {
      id: modal.id ?? "",
      title: modal.title,
      description: modal.description,
      dueAtISO: due.toISOString(),
      allDay: String(!modal.time),
      engagementId: modal.enquiryId,
      assigneeAgentId: assigneeAgentId ?? "",
    });
  }

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  function handOffCell(t: TaskRow) {
    if (t.status === "done" || t.status === "cancelled") return <span />;
    if (t.assigneeIsAgent) {
      return (
        <span className="light-chip justify-self-start rounded px-1.5 py-0.5 font-mono text-[8.5px] font-bold tracking-[.08em] uppercase">
          → With Light
        </span>
      );
    }
    if (t.status === "awaiting_approval") {
      return (
        <span className="light-chip justify-self-start rounded px-1.5 py-0.5 font-mono text-[8.5px] font-bold tracking-[.08em] uppercase">
          Awaiting stamp
        </span>
      );
    }
    if (!agent) return <span />;
    return (
      <button
        type="button"
        disabled={pending}
        onClick={() => run(handToLightAction, { id: t.id, agentId: agent.id })}
        className="light-btn-soft justify-self-start rounded-md px-2.5 py-1 font-mono text-[9.5px] font-bold tracking-wide whitespace-nowrap"
      >
        ✦ Hand to Light
      </button>
    );
  }

  function taskRow(t: TaskRow) {
    const done = t.status === "done";
    return (
      <div
        key={t.id}
        className="grid grid-cols-[22px_1fr_92px_156px] items-center gap-2.5 py-1.5"
      >
        <button
          type="button"
          aria-label={done ? "Reopen task" : "Complete task"}
          disabled={pending}
          onClick={() => run(setTaskStatusAction, { id: t.id, done: String(!done) })}
          className={cn(
            "flex size-4 items-center justify-center rounded border-[1.5px] text-[10px]",
            done ? "border-ledger bg-ledger text-white" : "border-rule text-transparent"
          )}
        >
          ✓
        </button>
        <button
          type="button"
          onClick={() => openTask(t)}
          className={cn(
            "text-left text-[13.5px]",
            done && "text-ink-faint line-through"
          )}
        >
          {t.title}
          {t.createdByAgent ? <span className="light-text"> ✦</span> : null}
        </button>
        <button
          type="button"
          onClick={() => openTask(t)}
          className="justify-self-start rounded border border-rule px-1.5 py-0.5 font-mono text-[9.5px] text-ink-faint hover:border-accent hover:text-accent"
        >
          {t.dueAt && !t.allDay ? formatTime(t.dueAt).slice(0, 5) : "+ time"}
        </button>
        {handOffCell(t)}
      </div>
    );
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex gap-1.5">
          {(["week", "month"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cn(
                "rounded-2xl border px-3 py-1 font-mono text-[11px] font-semibold tracking-wide uppercase",
                view === v ? "border-ink bg-ink text-paper" : "border-rule bg-panel text-ink-soft"
              )}
            >
              {v === "week" ? "Week" : "Month"}
            </button>
          ))}
        </div>
        {view === "week" ? (
          <div className="flex items-center gap-1 font-mono text-[11px] text-ink-soft">
            <button
              type="button"
              aria-label="Previous week"
              className="glass size-7 rounded-md"
              onClick={() => setWeekStart(addDays(weekStart, -7))}
            >
              ‹
            </button>
            <span className="px-1">
              Week of {weekStart.getDate()} {(MONTHS[weekStart.getMonth()] ?? "").slice(0, 3)}
            </span>
            <button
              type="button"
              aria-label="Next week"
              className="glass size-7 rounded-md"
              onClick={() => setWeekStart(addDays(weekStart, 7))}
            >
              ›
            </button>
          </div>
        ) : null}
        <div className="ml-auto">
          <Button variant="primary" onClick={() => setModal(emptyModal(today))}>
            + New task
          </Button>
        </div>
      </div>
      {error && !modal ? (
        <p className="mb-2 font-mono text-[11px] text-stamp uppercase">{error}</p>
      ) : null}

      {view === "week" ? (
        <div>
          {undated.length ? (
            <div className="glass mb-2.5 overflow-hidden rounded-xl">
              <div className="px-5 pt-3.5 pb-1 font-mono text-[9.5px] font-semibold tracking-[.14em] text-ink-faint uppercase">
                No day yet — workflow-born tasks await a day
              </div>
              <div className="px-5 pb-3.5">{undated.map(taskRow)}</div>
            </div>
          ) : null}
          {days.map((day) => {
            const key = day.toDateString();
            const list = byDay.get(key) ?? [];
            const openCount = list.filter((t) => t.status === "open").length;
            const isToday = sameDay(day, today);
            const weekend = day.getDay() === 0 || day.getDay() === 6;
            const open = openDays.has(key);
            return (
              <div key={key} className="glass mb-2.5 overflow-hidden rounded-xl">
                <button
                  type="button"
                  onClick={() =>
                    setOpenDays((prev) => {
                      const next = new Set(prev);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                  className={cn(
                    "flex w-full items-baseline gap-3.5 px-5 py-3.5 text-left font-display font-extrabold",
                    weekend ? "text-base text-ink-soft" : "text-2xl"
                  )}
                >
                  {day.toLocaleDateString("en-GB", { weekday: "long" })}
                  <span className="font-mono text-[9.5px] font-semibold tracking-[.14em] text-ink-faint uppercase">
                    {day.getDate()} {(MONTHS[day.getMonth()] ?? "").slice(0, 3)}
                    {isToday ? " · Today" : ""} ·{" "}
                    {list.length ? `${openCount} open` : "—"}
                  </span>
                </button>
                {open ? (
                  <div className="px-5 pb-3.5">
                    {list.length ? (
                      <div className="grid grid-cols-[22px_1fr_92px_156px] gap-2.5 py-0.5 font-mono text-[8px] tracking-[.14em] text-ink-faint uppercase">
                        <span /><span /><span>Time</span><span>Hand-off</span>
                      </div>
                    ) : null}
                    {list.map(taskRow)}
                    <button
                      type="button"
                      onClick={() => setModal(emptyModal(day))}
                      className="flex items-center gap-2 pt-2 pb-0.5 text-[13px] text-ink-faint hover:text-ink-soft"
                    >
                      Add a task…{" "}
                      {isToday ? (
                        <span className="light-text font-mono text-[9px] uppercase">
                          ✦ or just tell Light in “Ask Light anything”
                        </span>
                      ) : null}
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="glass overflow-hidden rounded-xl">
          <h2 className="flex items-center gap-2 border-b border-rule bg-paper px-4 py-3 font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-soft uppercase">
            <button
              type="button"
              aria-label="Previous month"
              className="glass size-6 rounded-md"
              onClick={() =>
                setMonthAnchor(new Date(monthAnchor.getFullYear(), monthAnchor.getMonth() - 1, 1))
              }
            >
              ‹
            </button>
            {MONTHS[monthAnchor.getMonth()]} {monthAnchor.getFullYear()} · tap a day
            <button
              type="button"
              aria-label="Next month"
              className="glass size-6 rounded-md"
              onClick={() =>
                setMonthAnchor(new Date(monthAnchor.getFullYear(), monthAnchor.getMonth() + 1, 1))
              }
            >
              ›
            </button>
          </h2>
          <div className="grid grid-cols-7 gap-1.5 px-4 pt-2.5 pb-0">
            {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
              <div key={i} className="text-center font-mono text-[9.5px] text-ink-faint">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1.5 p-4 pt-2">
            {Array.from({
              length: (new Date(monthAnchor.getFullYear(), monthAnchor.getMonth(), 1).getDay() + 6) % 7,
            }).map((_, i) => (
              <div key={`pad-${i}`} />
            ))}
            {Array.from({
              length: new Date(monthAnchor.getFullYear(), monthAnchor.getMonth() + 1, 0).getDate(),
            }).map((_, i) => {
              const d = new Date(monthAnchor.getFullYear(), monthAnchor.getMonth(), i + 1);
              const count = (byDay.get(d.toDateString()) ?? []).length;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    setWeekStart(startOfWeek(d));
                    setOpenDays(new Set([d.toDateString()]));
                    setView("week");
                  }}
                  className={cn(
                    "min-h-14 rounded-lg border p-1.5 text-left font-mono text-[10px] text-ink-soft hover:border-accent",
                    sameDay(d, today) ? "border-2 border-accent" : "border-rule"
                  )}
                >
                  {i + 1}
                  {count ? (
                    // A count is a kind, not Light's hand — accent, not gold
                    // (decision 61 outranks the mockup's gold pixel here).
                    <span className="mt-1.5 block w-fit min-w-4 rounded-lg border border-accent bg-accent-tint px-1 py-px text-center text-[8.5px] font-bold text-accent">
                      {count}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <p className="mt-3.5 font-mono text-xs text-ink-faint">
        SAME TASKS TABLE THE WORKFLOWS WRITE TO — A NURTURE STEP&rsquo;S &ldquo;CALL THE
        CLIENT&rdquo; LANDS HERE. YOURS AND LIGHT&rsquo;S IN ONE LIST, SPLIT BY WHO CAN
        ACTUALLY DO THEM.
      </p>

      {modal ? (
        <TaskModal
          modal={modal}
          setModal={setModal}
          enquiries={enquiries}
          agent={agent}
          error={error}
          pending={pending}
          onSave={() => saveModal()}
          onHandToLight={
            agent
              ? () =>
                  modal.id
                    ? run(handToLightAction, { id: modal.id, agentId: agent.id })
                    : saveModal(agent.id)
              : null
          }
        />
      ) : null}
    </>
  );
}

function TaskModal({
  modal,
  setModal,
  enquiries,
  agent,
  error,
  pending,
  onSave,
  onHandToLight,
}: {
  modal: ModalState;
  setModal: (m: ModalState | null) => void;
  enquiries: EnquiryOption[];
  agent: { id: string; name: string } | null;
  error: string | null;
  pending: boolean;
  onSave: () => void;
  onHandToLight: (() => void) | null;
}) {
  const [pop, setPop] = useState<"cal" | "clock" | "enq" | null>(null);
  const [cal, setCal] = useState({ y: modal.day.y, m: modal.day.m });
  const titleRef = useRef<HTMLInputElement>(null);

  // v2 openTask()/tkEdit(): the name field takes focus whenever editable.
  useEffect(() => {
    if (modal.editing) titleRef.current?.focus();
  }, [modal.editing]);
  const [hh, setHH] = useState(modal.time ? modal.time.split(":")[0] : "09");
  const [mm, setMM] = useState(modal.time ? modal.time.split(":")[1] : "00");
  const [enqQuery, setEnqQuery] = useState(modal.enquiryLabel);

  const editing = modal.editing;
  const dayLabel = `${DOW[(new Date(modal.day.y, modal.day.m, modal.day.d).getDay() + 6) % 7] ?? ""} ${modal.day.d} ${(MONTHS[modal.day.m] ?? "").slice(0, 3)}`;
  const enqHits = enquiries.filter((e) =>
    e.title.toLowerCase().includes(enqQuery.trim().toLowerCase())
  );

  const fieldCls =
    "rounded-xl border-[1.5px] border-rule bg-paper px-3.5 py-2.5 font-mono text-xs text-ink disabled:pointer-events-none disabled:opacity-75 disabled:bg-paper-deep";

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        className="fixed inset-0 z-90 bg-ink/40 backdrop-blur-xs"
        onClick={() => setModal(null)}
      />
      <div
        role="dialog"
        aria-label="Task"
        className="glass fixed top-1/2 left-1/2 z-91 w-[min(640px,94vw)] -translate-x-1/2 -translate-y-1/2 overflow-visible rounded-[28px] shadow-[0_24px_80px_rgba(32,43,56,.22)]"
        onClick={() => setPop(null)}
      >
        <div className="flex items-center gap-2 px-6 pt-4 font-mono text-[9.5px] font-bold tracking-[.16em] text-ink-faint uppercase">
          <span className="light-spark text-[13px]">✦</span>
          {modal.id ? "Task" : "New task"}
          {!editing ? (
            <Button
              size="sm"
              className="ml-auto"
              onClick={() => setModal({ ...modal, editing: true })}
            >
              Edit
            </Button>
          ) : null}
        </div>
        <div className="px-6 pt-2.5">
          <input
            ref={titleRef}
            value={modal.title}
            disabled={!editing}
            onChange={(e) => setModal({ ...modal, title: e.target.value })}
            placeholder="What needs doing?"
            className={cn(fieldCls, "w-full font-sans text-[15px]")}
          />
          <div className="relative mt-2.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!editing}
              onClick={(e) => {
                e.stopPropagation();
                setPop(pop === "cal" ? null : "cal");
              }}
              className={fieldCls}
            >
              {dayLabel}
            </button>
            <button
              type="button"
              disabled={!editing}
              onClick={(e) => {
                e.stopPropagation();
                setPop(pop === "clock" ? null : "clock");
              }}
              className={fieldCls}
            >
              {modal.time || "+ time"}
            </button>
            <span className="relative min-w-[220px] flex-1">
              <input
                value={enqQuery}
                disabled={!editing}
                onChange={(e) => {
                  setEnqQuery(e.target.value);
                  setPop("enq");
                }}
                onFocus={() => editing && setPop("enq")}
                onClick={(e) => e.stopPropagation()}
                placeholder="Link an enquiry — search…"
                className={cn(fieldCls, "w-full pr-8 text-left")}
              />
              <Search className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-ink-faint" />
              {pop === "enq" && editing ? (
                <div
                  className="glass absolute top-[calc(100%+4px)] right-0 left-0 z-95 max-h-45 overflow-auto rounded-xl p-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  {enqHits.length ? (
                    enqHits.map((e) => (
                      <button
                        key={e.id}
                        type="button"
                        className="block w-full rounded-md px-2.5 py-2 text-left font-mono text-[11.5px] hover:bg-paper-deep"
                        onClick={() => {
                          setModal({ ...modal, enquiryId: e.id, enquiryLabel: e.title });
                          setEnqQuery(e.title);
                          setPop(null);
                        }}
                      >
                        {e.title}
                        {e.stageLabel ? ` — ${e.stageLabel}` : ""}
                      </button>
                    ))
                  ) : (
                    <div className="px-2.5 py-2 font-mono text-[11.5px] text-ink-faint">
                      No match — refine the search
                    </div>
                  )}
                  {modal.enquiryId ? (
                    <button
                      type="button"
                      className="block w-full rounded-md px-2.5 py-2 text-left font-mono text-[11.5px] text-stamp hover:bg-paper-deep"
                      onClick={() => {
                        setModal({ ...modal, enquiryId: "", enquiryLabel: "" });
                        setEnqQuery("");
                        setPop(null);
                      }}
                    >
                      ✕ Remove the link
                    </button>
                  ) : null}
                </div>
              ) : null}
            </span>

            {pop === "cal" ? (
              <div
                className="glass absolute top-[calc(100%+4px)] left-0 z-95 w-[270px] rounded-xl p-2.5"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between px-0.5 pb-1.5 font-display text-[13px] font-extrabold">
                  <button
                    type="button"
                    aria-label="Previous month"
                    className="glass size-7 rounded-md font-sans"
                    onClick={() =>
                      setCal(cal.m === 0 ? { y: cal.y - 1, m: 11 } : { y: cal.y, m: cal.m - 1 })
                    }
                  >
                    ‹
                  </button>
                  {MONTHS[cal.m]} {cal.y}
                  <button
                    type="button"
                    aria-label="Next month"
                    className="glass size-7 rounded-md font-sans"
                    onClick={() =>
                      setCal(cal.m === 11 ? { y: cal.y + 1, m: 0 } : { y: cal.y, m: cal.m + 1 })
                    }
                  >
                    ›
                  </button>
                </div>
                <div className="grid grid-cols-7 gap-1 pb-1">
                  {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
                    <div key={i} className="text-center font-mono text-[9.5px] text-ink-faint">
                      {d}
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-0.5">
                  {Array.from({ length: (new Date(cal.y, cal.m, 1).getDay() + 6) % 7 }).map(
                    (_, i) => (
                      <div key={`p-${i}`} />
                    )
                  )}
                  {Array.from({ length: new Date(cal.y, cal.m + 1, 0).getDate() }).map((_, i) => {
                    const selected =
                      modal.day.y === cal.y && modal.day.m === cal.m && modal.day.d === i + 1;
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={() => {
                          setModal({ ...modal, day: { y: cal.y, m: cal.m, d: i + 1 } });
                          setPop(null);
                        }}
                        className={cn(
                          "rounded-md border border-rule py-1 text-center font-mono text-[10px] text-ink-soft hover:border-accent",
                          selected && "border-accent bg-accent text-white"
                        )}
                      >
                        {i + 1}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {pop === "clock" ? (
              <div
                className="glass absolute top-[calc(100%+4px)] left-27 z-95 rounded-xl p-2.5"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-2 p-0.5">
                  <select
                    size={6}
                    value={hh}
                    onChange={(e) => setHH(e.target.value)}
                    aria-label="Hours"
                    className="rounded-md border border-rule bg-panel font-mono text-[11px] text-ink"
                  >
                    {Array.from({ length: 24 }).map((_, h) => (
                      <option key={h}>{String(h).padStart(2, "0")}</option>
                    ))}
                  </select>
                  <b className="font-mono">:</b>
                  <select
                    size={6}
                    value={mm}
                    onChange={(e) => setMM(e.target.value)}
                    aria-label="Minutes"
                    className="rounded-md border border-rule bg-panel font-mono text-[11px] text-ink"
                  >
                    {Array.from({ length: 12 }).map((_, i) => (
                      <option key={i}>{String(i * 5).padStart(2, "0")}</option>
                    ))}
                  </select>
                  <div className="flex flex-col gap-1.5">
                    <Button
                      size="sm"
                      onClick={() => {
                        setModal({ ...modal, time: `${hh}:${mm}` });
                        setPop(null);
                      }}
                    >
                      Set
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        setModal({ ...modal, time: "" });
                        setPop(null);
                      }}
                    >
                      No time
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
          <textarea
            value={modal.description}
            disabled={!editing}
            onChange={(e) => setModal({ ...modal, description: e.target.value })}
            placeholder="Description — anything future-you or Light should know…"
            className={cn(fieldCls, "mt-2.5 min-h-21 w-full resize-y font-sans text-[13.5px]")}
          />
          <p className="mt-2.5 font-mono text-[9px] tracking-[.05em] text-ink-faint uppercase">
            Every task has a day, so every task syncs to your connected calendar — timed ones
            as events, untimed as all-day. Linked enquiries show the task on their timeline too.
          </p>
          {error ? (
            <p className="mt-2 font-mono text-[10.5px] text-stamp uppercase">{error}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5 border-t border-rule px-4.5 py-3.5">
          {onHandToLight && agent ? (
            <Button variant="gold" disabled={pending} onClick={onHandToLight}>
              ✦ Hand to Light
            </Button>
          ) : null}
          {editing ? (
            <button
              type="button"
              aria-label="Save task"
              disabled={pending}
              onClick={onSave}
              className="light-btn ml-auto flex h-11 w-18 items-center justify-center rounded-3xl disabled:opacity-50"
            >
              ↑
            </button>
          ) : (
            <span className="ml-auto" />
          )}
        </div>
      </div>
    </>
  );
}
