"use client";

import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Paperclip, Search } from "lucide-react";

import { formatWhen } from "@/lib/format";
import type { ConversationThread, ThreadMessage } from "@/lib/server/queries";
import { cn } from "@/lib/utils";

/*
 * view-convos, master mockup v2. Sending is NEXT session (outbound sends are
 * out of scope) — both composer modes render exactly as drawn and refuse
 * honestly on submit. Unread and starred are per-user state with no backing
 * columns yet, so those two filter chips render disabled, never pretending.
 */

const CHANNEL_LABELS: Record<string, string> = {
  email: "Email",
  whatsapp: "WhatsApp",
  sms: "SMS",
  call: "Call",
  meeting: "Meeting",
  portal_message: "Portal",
  internal_note: "Internal",
};

function channelChipClass(channel: string): string {
  if (channel === "whatsapp") return "border-[#bbd6c4] bg-[#eef6f0] text-[#2e6b4f]";
  if (channel === "email") return "border-[#c4d0e0] bg-[#eef2f8] text-[#3e5a78]";
  if (channel === "sms") return "border-[#e0d4c4] bg-[#f8f3ec] text-[#8a6230]";
  return "border-rule bg-paper text-ink-soft";
}

function initials(name: string): string {
  return name
    .replace(/"/g, "")
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/*
 * The per-user conversation view (Settings → Appearance — the ONLY door,
 * decision 77). Read as PART OF THE RENDER via useSyncExternalStore: during
 * hydration React swaps to the client snapshot synchronously before paint —
 * no effect racing the first paint, no second writer, no state initialiser
 * for the SSR default to win.
 */
function subscribeConvView(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

function readConvViewDefault(): "phone" | "standard" {
  try {
    return document.documentElement.dataset.convview === "standard" ||
      localStorage.getItem("ui-convview") === "standard"
      ? "standard"
      : "phone";
  } catch {
    return "phone";
  }
}

function stateChipClass(tone: "gold" | "you" | "done"): string {
  if (tone === "gold") return "light-chip";
  if (tone === "you") return "border border-[#e8c4bc] bg-stamp-tint text-stamp";
  return "border border-ledger-line bg-ledger-tint text-ledger";
}

function Bubble({ message, thread }: { message: ThreadMessage; thread: ConversationThread }) {
  if (message.channel === "call") {
    return (
      <div className="glass w-[90%] self-center rounded-lg px-3 py-2 text-xs">
        <span className="font-bold">☏ Call logged</span> — {message.body}
        <span className="mt-0.5 block font-mono text-[8.5px] tracking-wide text-ink-faint">
          {formatWhen(message.occurredAt)} · communications row · channel: call
          {message.durationSeconds ? ` · ${Math.round(message.durationSeconds / 60)} min` : ""}
        </span>
      </div>
    );
  }
  /*
   * Founder amendment (fix round 4, decision 78): alignment follows the
   * AUTHOR SIDE, never the state. Firm-authored — Light drafts, stamped
   * sends, direct messages, internal notes — sit right with a left gap;
   * client inbound sits left with a right gap. A draft and its stamped
   * version share a side; state changes the chrome (dashed light-panel,
   * NOT YET SENT label), never the side. Bubbles cap at ~72% of the pane
   * at every viewport width (fluid shell, decision 76).
   */
  if (message.isPendingDraft) {
    return (
      <>
        <div className="light-panel max-w-[72%] self-end rounded-xl rounded-br-sm border-dashed px-2.5 py-2 text-[12.5px] leading-normal shadow-panel">
          <span className="light-head mb-1 block font-mono text-[8.5px] font-semibold tracking-[.08em] uppercase">
            ✦ Light&rsquo;s draft — not yet sent
          </span>
          {message.body}
          <span className="mt-1 block text-right font-mono text-[8.5px] tracking-wide text-ink-faint">
            {message.scheduledFor
              ? `scheduled — sends ${formatWhen(message.scheduledFor)} on approval`
              : `drafted ${formatWhen(message.occurredAt)}`}
          </span>
        </div>
        <div className="-mt-0.5 flex gap-1.5 self-end">
          <Link
            href="/inbox"
            className="light-btn-soft rounded-md px-2.5 py-1 font-mono text-[9.5px] font-semibold tracking-wide uppercase"
          >
            Open in Approval Inbox →
          </Link>
        </div>
      </>
    );
  }
  const inbound = message.direction === "inbound";
  const isEmail = message.channel === "email";
  return (
    <div
      className={cn(
        "max-w-[72%] rounded-[13px] border px-2.5 py-2 text-[12.5px] leading-normal shadow-panel",
        inbound
          ? "self-start rounded-bl-sm border-rule bg-panel"
          : "self-end rounded-br-sm border-ledger-line bg-accent-tint",
        isEmail && "rounded-lg"
      )}
    >
      {isEmail && thread.subject ? (
        <span className="mb-1 block border-b border-dashed border-rule pb-1 font-mono text-[9px] tracking-wide text-ink-soft uppercase">
          {thread.subject}
        </span>
      ) : null}
      {message.body}
      <span
        className={cn(
          "mt-1 block font-mono text-[8.5px] tracking-wide text-ink-faint",
          inbound ? "text-left" : "text-right"
        )}
      >
        {formatWhen(message.occurredAt)}
      </span>
      {!inbound && message.draftedByLight ? (
        <span className="light-text mt-0.5 block text-right font-mono text-[8.5px] tracking-wide">
          ✦ drafted by Light{message.stampedByName ? ` · stamped by ${message.stampedByName}` : ""}
        </span>
      ) : null}
    </div>
  );
}

export function ConversationsClient({ threads }: { threads: ConversationThread[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(threads[0]?.id ?? null);
  const [filter, setFilter] = useState<"all" | "you" | "light">("all");
  const [query, setQuery] = useState("");
  // Founder amendment (fix round 4, decision 77): the header quick-switch is
  // GONE — two writers (view-local toggle vs the appearance stamp) raced on
  // one value, so the second writer is removed. Settings → Appearance is the
  // only door; the stamp is the single source and the view renders from it.
  const view = useSyncExternalStore(
    subscribeConvView,
    readConvViewDefault,
    () => "phone" as const
  );
  const [mode, setMode] = useState<"direct" | "light">("direct");
  const [railOpen, setRailOpen] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [listWidth, setListWidth] = useState(330);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);

  // v2's draggable divider — clamp 250–520px, exactly its bounds.
  function startDrag(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const rect = splitRef.current?.getBoundingClientRect();
      if (!rect) return;
      setListWidth(Math.min(520, Math.max(250, ev.clientX - rect.left)));
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return threads.filter((t) => {
      if (filter === "you" && !t.awaitingYou) return false;
      if (filter === "light" && !(t.lightHandling || t.hasPendingDraft)) return false;
      if (
        q &&
        !t.contactName.toLowerCase().includes(q) &&
        !t.messages.some((m) => m.body.toLowerCase().includes(q))
      )
        return false;
      return true;
    });
  }, [threads, filter, query]);

  const selected = threads.find((t) => t.id === selectedId) ?? visible[0] ?? null;

  const awaitingCount = threads.filter((t) => t.awaitingYou).length;
  const lightCount = threads.filter((t) => t.lightHandling || t.hasPendingDraft).length;

  if (!threads.length) {
    return (
      <div className="glass mx-auto mt-10 max-w-[560px] rounded-2xl border-dashed p-9 text-center">
        <h2 className="mb-2 font-display text-xl font-extrabold">No conversations yet</h2>
        <p className="mx-auto max-w-[42ch] text-sm text-ink-soft">
          Threads appear here the moment a message rides a channel — every one a
          row on The Record, nothing deletable.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-[480px] flex-col" style={{ height: "calc(100vh - 132px)" }}>
      <div
        ref={splitRef}
        className="glass flex min-h-0 flex-1 overflow-hidden rounded-xl max-[900px]:flex-col"
      >
        {/* Thread list */}
        <div
          style={{ width: listWidth }}
          className="flex min-h-0 shrink-0 flex-col max-[900px]:max-h-[38vh] max-[900px]:!w-full max-[900px]:border-b max-[900px]:border-rule"
        >
          <div className="border-b border-rule px-3.5 pt-3 pb-2.5">
            <label className="mb-2.5 flex items-center gap-2 rounded-lg border border-rule bg-paper px-2.5 py-1.5 text-[13px] text-ink-faint">
              <Search className="size-3.5" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search people or messages…"
                className="w-full bg-transparent text-ink outline-none placeholder:text-ink-faint"
              />
            </label>
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  ["all", `All · ${threads.length}`],
                  ["you", `Awaiting you · ${awaitingCount}`],
                  ["light", `Light handling · ${lightCount}`],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFilter(key)}
                  className={cn(
                    "rounded-xl border px-2 py-1 font-mono text-[10px] tracking-wide uppercase",
                    filter === key
                      ? "border-ink bg-ink font-semibold text-paper"
                      : "border-rule bg-paper text-ink-soft"
                  )}
                >
                  {label}
                </button>
              ))}
              {/* Read-state and stars are per-user columns that do not exist
                  yet — the chips render disabled rather than pretending. */}
              {["Unread", "★ Starred"].map((label) => (
                <span
                  key={label}
                  title="Per-user read-state and stars arrive with their session"
                  className="cursor-not-allowed rounded-xl border border-dashed border-rule px-2 py-1 font-mono text-[10px] tracking-wide text-ink-faint/60 uppercase"
                >
                  {label}
                </span>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {visible.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setSelectedId(t.id)}
                className={cn(
                  "relative flex w-full items-start gap-2.5 border-b border-paper-deep px-3.5 py-3 text-left hover:bg-paper",
                  selected?.id === t.id &&
                    "bg-paper-deep shadow-[inset_3px_0_0_var(--accent)]"
                )}
              >
                <span className="flex size-8.5 shrink-0 items-center justify-center rounded-full border border-rule bg-paper-deep text-xs font-bold text-ink-soft">
                  {initials(t.contactName)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <b className="truncate text-[13.5px] font-semibold">{t.contactName}</b>
                    <span className="ml-auto shrink-0 font-mono text-[9.5px] text-ink-faint">
                      {formatWhen(t.lastAt)}
                    </span>
                  </span>
                  <span className="mt-px block truncate text-xs text-ink-soft">{t.snippet}</span>
                  <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <span
                      className={cn(
                        "rounded border px-1.5 py-px font-mono text-[9px] tracking-wide uppercase",
                        channelChipClass(t.channel)
                      )}
                    >
                      {CHANNEL_LABELS[t.channel] ?? t.channel}
                    </span>
                    <span
                      className={cn(
                        "rounded-lg px-1.5 py-px font-mono text-[9px] tracking-wide uppercase",
                        stateChipClass(t.state.tone)
                      )}
                    >
                      {t.state.label}
                    </span>
                  </span>
                </span>
              </button>
            ))}
            {!visible.length ? (
              <p className="p-4 text-center font-mono text-[10.5px] text-ink-faint uppercase">
                No threads match
              </p>
            ) : null}
          </div>
        </div>

        {/* v2 divider — drag to resize the thread list */}
        <div
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize"
          onPointerDown={startDrag}
          className="flex w-2 shrink-0 cursor-col-resize items-center justify-center border-x border-rule bg-paper-deep text-[13px] text-ink-faint hover:bg-accent-tint max-[900px]:hidden"
        >
          ⋮
        </div>

        {/* Right pane */}
        {selected ? (
          <div className="flex min-w-0 flex-1 flex-col bg-paper">
            <div className="flex flex-wrap items-center gap-2 border-b border-rule bg-panel px-3.5 py-2.5">
              <span className="text-sm font-bold">{selected.contactName}</span>
              {selected.enquiry ? (
                <>
                  <span className="font-mono text-[10px] tracking-wide text-ink-faint">
                    {selected.enquiry.title}
                    {selected.enquiry.stageLabel ? ` · ${selected.enquiry.stageLabel}` : ""}
                  </span>
                  <Link
                    href={`/enquiries/${selected.enquiry.id}`}
                    className="ml-auto font-mono text-[10.5px] font-semibold tracking-wide text-accent"
                  >
                    Open enquiry →
                  </Link>
                </>
              ) : (
                <span className="ml-auto" />
              )}
              {/* The phone/standard toggle is gone (decision 77) — Settings →
                  Appearance → Conversation view is the only door. */}
              {/* v2 quick actions. Star and read-state need per-user columns
                  that do not exist — those two render disabled, stated on
                  hover. Log-a-call and archive answer with the mockup's own
                  explanations until their writes land. */}
              <span
                title="Starred threads are a personal pin, per user — the column arrives with its session"
                className="glass flex size-7.5 cursor-not-allowed items-center justify-center rounded-md text-[13px] text-ink-faint/50"
              >
                ★
              </span>
              <span
                title="Read-state is per user — the column arrives with its session"
                className="glass flex size-7.5 cursor-not-allowed items-center justify-center rounded-md text-[13px] text-ink-faint/50"
              >
                ✉
              </span>
              <button
                type="button"
                title="Log a call"
                className="glass size-7.5 rounded-md text-[13px] text-ink-soft"
                onClick={() =>
                  setNotice(
                    "Logs a communications row — channel: call, duration, outcome. The write arrives with the telephony session; click-to-call with recording is Phase 2."
                  )
                }
              >
                ☏
              </button>
              <button
                type="button"
                title="Archive thread"
                className="glass size-7.5 rounded-md text-[13px] text-ink-soft"
                onClick={() =>
                  setNotice(
                    "Archived — hidden from the list, never deleted; every message stays on The Record (archived_at). The write arrives with its session. There is no delete button on correspondence, by design."
                  )
                }
              >
                ⌫
              </button>
              <button
                type="button"
                onClick={() => setRailOpen((v) => !v)}
                title="Contact rail"
                className={cn(
                  "glass size-7.5 rounded-md text-[13px] max-[1100px]:hidden",
                  railOpen && "light-chip"
                )}
              >
                ◨
              </button>
            </div>
            <div className="flex min-h-0 flex-1">
              <div className="flex min-w-0 flex-1 flex-col">
                <div
                  className={cn(
                    "flex min-h-0 flex-1 justify-center",
                    view === "phone" ? "px-4 pt-4 pb-3.5" : "p-0"
                  )}
                >
                  <div
                    className={cn(
                      "flex flex-col",
                      view === "phone"
                        ? "h-full w-[min(360px,100%)] rounded-[26px] bg-ink p-2 shadow-[0_14px_40px_rgba(32,43,56,.22)]"
                        : "h-full w-full"
                    )}
                  >
                    <div
                      className={cn(
                        "flex min-h-0 flex-1 flex-col overflow-hidden",
                        view === "phone" && "rounded-[19px] bg-[#f4f1e9]"
                      )}
                    >
                      {view === "phone" ? (
                        <>
                          <div className="flex items-center gap-2 border-b border-rule bg-panel px-3 py-2">
                            <span className="flex size-6.5 items-center justify-center rounded-full border border-rule bg-paper-deep text-[10px] font-bold text-ink-soft">
                              {initials(selected.contactName)}
                            </span>
                            <span>
                              <span className="block text-xs font-bold">
                                {selected.contactName}
                              </span>
                              <span className="block font-mono text-[9px] tracking-wide text-ink-faint uppercase">
                                {CHANNEL_LABELS[selected.channel] ?? selected.channel}
                              </span>
                            </span>
                          </div>
                          <div className="px-2.5 pt-1.5 text-center font-mono text-[9px] tracking-[.08em] text-ink-faint uppercase">
                            as the client sees it
                          </div>
                        </>
                      ) : null}
                      <div
                        className={cn(
                          "flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto",
                          view === "phone" ? "px-2.5 pt-2 pb-3.5" : "gap-2.5 px-5 pt-4 pb-4.5"
                        )}
                      >
                        {selected.messages.map((m) => (
                          <Bubble key={m.id} message={m} thread={selected} />
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Composer — both modes drawn; sending is next session. */}
                <div className="shrink-0 border-t border-rule bg-panel px-4 pt-2.5 pb-3">
                  <div className="mb-2 inline-flex gap-1 rounded-lg bg-paper-deep p-0.5">
                    <button
                      type="button"
                      onClick={() => setMode("direct")}
                      className={cn(
                        "flex items-center gap-1.5 rounded-md px-3 py-1.5 font-mono text-[10px] font-semibold tracking-wide uppercase",
                        mode === "direct" ? "bg-panel text-ink shadow-panel" : "text-ink-soft"
                      )}
                    >
                      ✍ Message directly
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode("light")}
                      className={cn(
                        "flex items-center gap-1.5 rounded-md px-3 py-1.5 font-mono text-[10px] font-semibold tracking-wide uppercase",
                        mode === "light" ? "light-chip" : "text-ink-soft"
                      )}
                    >
                      ✦ Brief Light
                    </button>
                  </div>
                  <div className="flex items-end gap-2">
                    <button
                      type="button"
                      title="Attach"
                      className="glass size-9.5 shrink-0 rounded-lg text-ink-soft"
                      onClick={() =>
                        setNotice(
                          "Manual attach — same control as the Approval Inbox draft editor; arrives with the send session."
                        )
                      }
                    >
                      <Paperclip className="mx-auto size-4" />
                    </button>
                    <textarea
                      ref={boxRef}
                      rows={1}
                      placeholder={
                        mode === "direct"
                          ? `Message ${selected.contactName.split(" ")[0]} directly on ${CHANNEL_LABELS[selected.channel] ?? selected.channel}…`
                          : "Tell Light what you want said — e.g. “offer her Thursday, mention the payslips”…"
                      }
                      className={cn(
                        "min-h-11 flex-1 resize-none rounded-lg border px-3 py-2.5 text-[13px] text-ink outline-none focus:outline-2 focus:-outline-offset-1",
                        mode === "light"
                          ? "light-panel focus:outline-gold"
                          : "border-rule bg-paper focus:outline-accent"
                      )}
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setNotice(
                          mode === "direct"
                            ? "The send pipeline arrives next session — nothing was sent, nothing was recorded."
                            : "Briefing Light arrives with its wiring session — nothing was drafted, nothing was recorded."
                        )
                      }
                      className={cn(
                        "h-9.5 shrink-0 rounded-lg px-4 text-[13px] font-bold text-white",
                        mode === "light" ? "light-btn" : "bg-accent"
                      )}
                    >
                      {mode === "direct" ? "Send" : "✦ Draft it"}
                    </button>
                  </div>
                  <p className="mt-1.5 font-mono text-[9.5px] tracking-[.04em] text-ink-faint">
                    {notice ? (
                      <span className="text-amber">{notice}</span>
                    ) : mode === "direct" ? (
                      <>
                        Sends immediately as <b className="text-ink-soft">you</b> · logged on The
                        Record · staff without send rights see only the Brief Light path here
                      </>
                    ) : (
                      <>
                        <span className="light-text font-semibold">
                          Light drafts from your brief
                        </span>{" "}
                        · the draft lands in this thread and your Approval Inbox ·{" "}
                        <b className="text-stamp">nothing sends without a stamp</b>
                      </>
                    )}
                  </p>
                </div>
              </div>

              {/* Contact rail */}
              {railOpen ? (
                <div className="w-[250px] shrink-0 overflow-y-auto border-l border-rule bg-panel max-[1100px]:hidden">
                  <div className="border-b border-rule px-3.5 pt-3 pb-2.5">
                    <div className="flex items-center gap-1.5 text-sm font-bold">
                      {selected.contactName}
                      <span
                        className={cn(
                          "rounded-lg border px-1.5 py-px font-mono text-[9px] tracking-wide uppercase",
                          selected.contact.isClient
                            ? "border-ledger-line bg-ledger-tint text-ledger"
                            : "border-rule bg-paper-deep text-ink-soft"
                        )}
                      >
                        {selected.contact.status === "junk"
                          ? "Junk"
                          : selected.contact.isClient
                            ? "Client"
                            : "Lead"}
                      </span>
                    </div>
                  </div>
                  <div className="border-b border-dashed border-rule px-3.5 py-2.5">
                    {(
                      [
                        ["Phone", selected.contact.phone ?? "—"],
                        ["Email", selected.contact.email ?? "—"],
                        [
                          "Source",
                          selected.contact.source
                            ? selected.contact.source === "meta"
                              ? "Meta"
                              : selected.contact.source
                            : "—",
                        ],
                      ] as const
                    ).map(([k, v]) => (
                      <div key={k}>
                        <span className="mt-2 mb-1 block font-mono text-[9px] font-semibold tracking-[.1em] text-ink-faint uppercase first:mt-0">
                          {k}
                        </span>
                        <span className="block text-[12.5px] break-words text-ink">{v}</span>
                      </div>
                    ))}
                  </div>
                  <div className="border-b border-dashed border-rule px-3.5 py-2.5">
                    <span className="mb-1 block font-mono text-[9px] font-semibold tracking-[.1em] text-ink-faint uppercase">
                      Channels &amp; consent
                    </span>
                    {selected.contact.consents.length ? (
                      selected.contact.consents.map((c) => (
                        <div
                          key={c.channel}
                          className="flex items-start gap-1.5 py-0.5 text-[11.5px] text-ink-soft"
                        >
                          <span
                            className={cn(
                              "font-bold",
                              c.ok ? "text-accent" : "text-stamp"
                            )}
                          >
                            {c.ok ? "✓" : "✕"}
                          </span>
                          <b className="w-16.5 shrink-0 font-semibold text-ink">
                            {CHANNEL_LABELS[c.channel] ?? c.channel}
                          </b>
                          <span>{c.note}</span>
                        </div>
                      ))
                    ) : (
                      <p className="text-[11.5px] text-ink-faint">No channels on file yet.</p>
                    )}
                    <p className="mt-1.5 border-t border-dashed border-rule pt-1.5 text-[10.5px] text-ink-faint">
                      Consent is per channel, not per person — this block is what the Approve
                      pre-flight reads. No separate DND system.
                    </p>
                  </div>
                  <Link
                    href={`/contacts/${selected.contactId}`}
                    className="block w-full px-3.5 py-3 text-center font-mono text-[10.5px] font-semibold tracking-wide text-accent"
                  >
                    Open full contact →
                  </Link>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
