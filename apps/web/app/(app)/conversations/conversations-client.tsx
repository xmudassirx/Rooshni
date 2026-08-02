"use client";

import {
  useActionState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Paperclip, Search } from "lucide-react";

import { formatWhen } from "@/lib/format";
import type {
  ConversationListItem,
  ConversationListPage,
  OpenThread,
  ThreadCursor,
  ThreadDraftStampData,
  ThreadMessage,
} from "@/lib/server/queries";
import { cn } from "@/lib/utils";
import {
  askLightToDraftAction,
  loadOlderMessagesAction,
  markThreadOpenedAction,
  sendDirectMessageAction,
  setAutoDraftPausedAction,
  setSettleOverrideAction,
  type ThreadActionState,
} from "./actions";
import { DraftStampPanel } from "./draft-stamp-panel";

/*
 * Session 23 (WS2, founder directive): Conversations matches Facebook
 * Messenger's shape. Desktop: thread list left, open thread right. Phone:
 * full-screen list; tapping opens the full-screen thread with a back
 * control; bubbles inbound-left / outbound-right (the decision 78 author-
 * side law already agrees); timestamps grouped as separators between bursts;
 * the composer pinned at the bottom. The phone-frame "as the client sees it"
 * novelty view is DEMOTED to an optional Appearance toggle — standard is the
 * default everywhere.
 *
 * The s22 5c deferral lands here: the thread list is windowed, a thread
 * opens on its recent tail, older messages arrive in bounded windows on
 * upward scroll, and a Realtime arrival APPENDS to the open thread without
 * a refetch (the shell's debounced server refresh reconciles over windowed
 * reads).
 *
 * JUDGMENT (reference-pattern gaps, marked per the prompt): Messenger's
 * search is global; ours filters the loaded page by name/snippet — global
 * message search is its own bounded-read session. The All/Awaiting/Light
 * filter chips are not part of Messenger's shape but carry this product's
 * stamp semantics, so they stay, scoped to the visible page.
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
 * decision 77). Session 23 flips the default: STANDARD unless the user has
 * chosen the phone frame. Read as part of the render via
 * useSyncExternalStore — no effect racing first paint, no second writer.
 */
function subscribeConvView(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

function readConvViewDefault(): "phone" | "standard" {
  try {
    return document.documentElement.dataset.convview === "phone" ||
      localStorage.getItem("ui-convview") === "phone"
      ? "phone"
      : "standard";
  } catch {
    return "standard";
  }
}

function stateChipClass(tone: "gold" | "you" | "done"): string {
  if (tone === "gold") return "light-chip";
  if (tone === "you") return "border border-[#e8c4bc] bg-stamp-tint text-stamp";
  return "border border-ledger-line bg-ledger-tint text-ledger";
}

/** Messenger groups messages into bursts — a centred time label opens each
 * burst rather than every bubble carrying its own timestamp. */
const BURST_GAP_MS = 25 * 60 * 1000;

function Bubble({
  message,
  thread,
  stamp,
  returnTo,
}: {
  message: ThreadMessage;
  thread: { subject: string | null };
  stamp?: ThreadDraftStampData | null;
  returnTo: string;
}) {
  // PR-iii (Session 19): the "as sent" HTML view for dispatched emails.
  const [showSentHtml, setShowSentHtml] = useState(false);
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
   * Decision 78: alignment follows the AUTHOR SIDE, never the state —
   * client inbound left, firm-authored right; state changes only the chrome.
   */
  if (message.direction === "outbound" && message.status === "superseded") {
    return (
      <div className="max-w-[72%] self-end rounded-xl rounded-br-sm border border-dashed border-rule bg-paper-deep px-2.5 py-2 text-[12.5px] leading-normal text-ink-faint opacity-80">
        <span className="mb-1 block font-mono text-[8.5px] font-semibold tracking-[.08em] uppercase">
          ⇢ superseded — replaced by a newer draft, never sent
        </span>
        <span className="line-clamp-2">{message.body}</span>
        <span className="mt-1 block text-right font-mono text-[8.5px] tracking-wide">
          {formatWhen(message.occurredAt)}
        </span>
      </div>
    );
  }
  if (message.isPendingDraft) {
    // Session 23 (WS1b): the bubble shows the render-resolved WYSIWYS body
    // when the viewer holds stamp authority — the same words the inbox card
    // shows and the stamp approves.
    const shownBody = stamp?.body ?? message.body;
    return (
      <>
        <div className="light-panel max-w-[72%] self-end rounded-xl rounded-br-sm border-dashed px-2.5 py-2 text-[12.5px] leading-normal whitespace-pre-wrap shadow-panel">
          <span className="light-head mb-1 block font-mono text-[8.5px] font-semibold tracking-[.08em] uppercase">
            ✦ Light&rsquo;s draft — not yet sent
          </span>
          {shownBody}
          <span className="mt-1 block text-right font-mono text-[8.5px] tracking-wide text-ink-faint">
            {message.scheduledFor
              ? `scheduled — sends ${formatWhen(message.scheduledFor)} on approval`
              : `drafted ${formatWhen(message.occurredAt)}`}
          </span>
        </div>
        {/* Session 23 (WS1b, founder-ruled): the inline stamp — the SAME
            server acts as the Approval Inbox; pre-flight visible, Approve
            withheld when blocked. The inbox link remains the queue view. */}
        {stamp ? (
          <DraftStampPanel
            stamp={{
              communicationId: stamp.communicationId,
              checks: stamp.checks,
              preflightPass: stamp.preflightPass,
              body: shownBody,
              signOffNote: stamp.signOffMode
                ? stamp.signOffResolvedTo
                  ? `sign-off resolves to you at the stamp — shown as it will send: ${stamp.signOffResolvedTo}`
                  : "sign-off resolves to the stamping approver at the stamp"
                : null,
              creditNote: stamp.creditNote,
            }}
            returnTo={returnTo}
          />
        ) : null}
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
      <span className="whitespace-pre-wrap">{message.body}</span>
      {message.sentHtml ? (
        <>
          <button
            type="button"
            onClick={() => setShowSentHtml((v) => !v)}
            aria-expanded={showSentHtml}
            className="mt-1 block cursor-pointer font-mono text-[8.5px] tracking-wide text-accent uppercase hover:underline"
          >
            {showSentHtml ? "− hide as sent" : "+ view as sent (HTML)"}
          </button>
          {showSentHtml ? (
            <iframe
              title="The email exactly as it was sent"
              sandbox=""
              srcDoc={message.sentHtml}
              className="mt-1 h-[300px] w-full rounded-md border border-rule bg-white"
            />
          ) : null}
        </>
      ) : null}
      {/* Messenger shape: burst separators carry the time; bubbles keep only
          the meta that states authorship or carriage state. */}
      {!inbound && message.draftedByLight ? (
        <span className="light-text mt-0.5 block text-right font-mono text-[8.5px] tracking-wide">
          ✦ drafted by Light{message.stampedByName ? ` · stamped by ${message.stampedByName}` : ""}
        </span>
      ) : null}
    </div>
  );
}

function ThreadListPane({
  list,
  selectedId,
  onOpen,
}: {
  list: ConversationListPage;
  selectedId: string | null;
  onOpen: (id: string) => void;
}) {
  const [filter, setFilter] = useState<"all" | "you" | "light">("all");
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return list.rows.filter((t) => {
      if (filter === "you" && !t.awaitingYou) return false;
      if (filter === "light" && !(t.lightHandling || t.hasPendingDraft)) return false;
      if (q && !t.contactName.toLowerCase().includes(q) && !t.snippet.toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [list.rows, filter, query]);

  return (
    <div className="flex min-h-0 w-full flex-col">
      <div className="border-b border-rule px-3.5 pt-3 pb-2.5">
        <label className="mb-2.5 flex items-center gap-2 rounded-lg border border-rule bg-paper px-2.5 py-1.5 text-[13px] text-ink-faint">
          <Search className="size-3.5" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search these conversations…"
            className="w-full bg-transparent text-ink outline-none placeholder:text-ink-faint"
          />
        </label>
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              ["all", "All"],
              ["you", "Awaiting you"],
              ["light", "Light handling"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={cn(
                "min-h-9 rounded-xl border px-2 py-1 font-mono text-[10px] tracking-wide uppercase",
                filter === key
                  ? "border-ink bg-ink font-semibold text-paper"
                  : "border-rule bg-paper text-ink-soft"
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {visible.map((t) => (
          <ThreadListRow key={t.id} item={t} selected={selectedId === t.id} onOpen={onOpen} />
        ))}
        {!visible.length ? (
          <p className="p-4 text-center font-mono text-[10.5px] text-ink-faint uppercase">
            No conversations match
          </p>
        ) : null}
        {/* 5c: the list is windowed — older pages are one tap away, with the
            total an aggregate, never a full fetch. */}
        {list.pageCount > 1 ? (
          <div className="flex items-center justify-between gap-2 px-3.5 py-3 font-mono text-[10px] tracking-wide text-ink-faint uppercase">
            <span>
              page {list.page} of {list.pageCount} · {list.total} conversations
            </span>
            <span className="flex gap-3">
              {list.page > 1 ? (
                <Link
                  href={`/conversations?lpage=${list.page - 1}`}
                  className="min-h-9 content-center text-accent hover:underline"
                >
                  ← newer
                </Link>
              ) : null}
              {list.page < list.pageCount ? (
                <Link
                  href={`/conversations?lpage=${list.page + 1}`}
                  className="min-h-9 content-center text-accent hover:underline"
                >
                  older →
                </Link>
              ) : null}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ThreadListRow({
  item,
  selected,
  onOpen,
}: {
  item: ConversationListItem;
  selected: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(item.id)}
      className={cn(
        "relative flex w-full items-start gap-2.5 border-b border-paper-deep px-3.5 py-3 text-left hover:bg-paper",
        selected && "bg-paper-deep shadow-[inset_3px_0_0_var(--accent)]"
      )}
    >
      <span className="flex size-8.5 shrink-0 items-center justify-center rounded-full border border-rule bg-paper-deep text-xs font-bold text-ink-soft">
        {initials(item.contactName)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <b className={cn("truncate text-[13.5px]", item.unread ? "font-extrabold" : "font-semibold")}>
            {item.contactName}
          </b>
          {/* Session 23 (WS1c): unread — a fact in accent chrome (never red:
              no stamp is owed by a message arriving). */}
          {item.unread ? (
            <span aria-label="Unread" className="size-2 shrink-0 rounded-full bg-accent" />
          ) : null}
          <span className="ml-auto shrink-0 font-mono text-[9.5px] text-ink-faint">
            {formatWhen(item.lastAt)}
          </span>
        </span>
        <span
          className={cn(
            "mt-px block truncate text-xs",
            item.unread ? "font-semibold text-ink" : "text-ink-soft"
          )}
        >
          {item.snippet}
        </span>
        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              "rounded border px-1.5 py-px font-mono text-[9px] tracking-wide uppercase",
              channelChipClass(item.channel)
            )}
          >
            {CHANNEL_LABELS[item.channel] ?? item.channel}
          </span>
          <span
            className={cn(
              "rounded-lg px-1.5 py-px font-mono text-[9px] tracking-wide uppercase",
              stateChipClass(item.state.tone)
            )}
          >
            {item.state.label}
          </span>
        </span>
      </span>
    </button>
  );
}

export function ConversationsClient({
  list,
  thread,
  explicitThread,
  draftStamps = {},
}: {
  list: ConversationListPage;
  /** The open thread's rail facts + recent tail; null when nothing exists. */
  thread: OpenThread | null;
  /** True when the URL names the thread — on a phone only an explicit open
   * shows (and reads) the thread; desktop auto-opens the newest. */
  explicitThread: boolean;
  draftStamps?: Record<string, ThreadDraftStampData>;
}) {
  const router = useRouter();
  const view = useSyncExternalStore(subscribeConvView, readConvViewDefault, () => "standard" as const);
  const [mode, setMode] = useState<"direct" | "light">("direct");
  const [railOpen, setRailOpen] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [listWidth, setListWidth] = useState(330);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);

  // 5c: older windows prepend, Realtime rows append — both client-held,
  // reconciled whenever the server re-renders the tail.
  const [older, setOlder] = useState<ThreadMessage[]>([]);
  const [live, setLive] = useState<ThreadMessage[]>([]);
  const [hasOlder, setHasOlder] = useState(thread?.hasOlder ?? false);
  const [oldestCursor, setOldestCursor] = useState<ThreadCursor | null>(
    thread?.oldestCursor ?? null
  );
  const loadingOlder = useRef(false);
  const threadId = thread?.id ?? null;

  useEffect(() => {
    // A different thread (or a fresh server tail) resets the client-held
    // windows; ids the server now carries are deduped out of `live`.
    setOlder([]);
    setLive([]);
    setHasOlder(thread?.hasOlder ?? false);
    setOldestCursor(thread?.oldestCursor ?? null);
  }, [threadId, thread?.hasOlder, thread?.oldestCursor]);

  const serverIds = useMemo(
    () => new Set((thread?.messages ?? []).map((m) => m.id)),
    [thread?.messages]
  );
  const messages = useMemo(() => {
    const olderFiltered = older.filter((m) => !serverIds.has(m.id));
    const liveFiltered = live.filter((m) => !serverIds.has(m.id));
    return [...olderFiltered, ...(thread?.messages ?? []), ...liveFiltered];
  }, [older, live, thread?.messages, serverIds]);

  // Session 16 — the real acts: direct send (insert-at-approved), Ask Light
  // (manual settle bypass), pause toggle and settle override.
  const INITIAL: ThreadActionState = { error: null };
  const [sendState, sendAction, sendPending] = useActionState(sendDirectMessageAction, INITIAL);
  const [askState, askAction, askPending] = useActionState(askLightToDraftAction, INITIAL);
  const [prefState, prefAction, prefPending] = useActionState(setAutoDraftPausedAction, INITIAL);
  const [settleState, settleAction] = useActionState(setSettleOverrideAction, INITIAL);

  useEffect(() => {
    if (sendState.done) {
      if (boxRef.current) boxRef.current.value = "";
      router.refresh();
    }
  }, [sendState, router]);
  useEffect(() => {
    if (askState.done || prefState.done || settleState.done) router.refresh();
  }, [askState, prefState, settleState, router]);

  const actionError = sendState.error ?? askState.error ?? prefState.error ?? settleState.error;

  // Opening navigates — the server renders the thread (and the open marks it
  // read); on a phone this switches the full-screen surface, Messenger-like.
  const openThread = useCallback(
    (id: string) => {
      router.push(`/conversations?thread=${id}${list.page > 1 ? `&lpage=${list.page}` : ""}`);
    },
    [router, list.page]
  );

  // Session 23 (WS1c): opening a thread clears its unread state. On a phone
  // the auto-opened desktop thread is never shown, so only an explicit open
  // clears there; desktop displays the thread, so displaying clears.
  const threadUnread = thread?.unread ?? false;
  useEffect(() => {
    if (!threadId || !threadUnread) return;
    const phone = window.matchMedia("(max-width: 900px)").matches;
    if (phone && !explicitThread) return;
    void markThreadOpenedAction(threadId).then(() => router.refresh());
  }, [threadId, threadUnread, explicitThread, router]);

  // A thread opens scrolled to its LATEST message.
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [threadId, view]);

  // 5c: upward scroll fetches the next older window, preserving the reading
  // position across the prepend.
  const onMessagesScroll = useCallback(() => {
    const el = messagesRef.current;
    if (!el || !threadId || !hasOlder || !oldestCursor || loadingOlder.current) return;
    if (el.scrollTop > 80) return;
    loadingOlder.current = true;
    const heightBefore = el.scrollHeight;
    void loadOlderMessagesAction(threadId, oldestCursor)
      .then((res) => {
        setOlder((prev) => [...res.messages, ...prev]);
        setHasOlder(res.hasOlder);
        if (res.oldestCursor) setOldestCursor(res.oldestCursor);
        requestAnimationFrame(() => {
          const after = messagesRef.current;
          if (after) after.scrollTop += after.scrollHeight - heightBefore;
        });
      })
      .finally(() => {
        loadingOlder.current = false;
      });
  }, [threadId, hasOlder, oldestCursor]);

  // 5c: a Realtime arrival on the open thread APPENDS without a refetch —
  // the shell's LiveInbox dispatches the row it received.
  useEffect(() => {
    function onCommChange(e: Event) {
      const detail = (e as CustomEvent).detail as
        | {
            eventType?: string;
            row?: {
              id?: string;
              thread_id?: string;
              channel?: string;
              direction?: string;
              status?: string;
              body?: string;
              body_format?: string;
              occurred_at?: string;
              scheduled_for?: string | null;
              duration_seconds?: number | null;
              attributes?: Record<string, unknown> | null;
            };
          }
        | undefined;
      const row = detail?.row;
      if (detail?.eventType !== "INSERT" || !row?.id || row.thread_id !== threadId) return;
      const el = messagesRef.current;
      const nearBottom = el ? el.scrollHeight - el.scrollTop - el.clientHeight < 160 : false;
      const plain =
        typeof row.attributes?.plain_body === "string" ? row.attributes.plain_body : null;
      setLive((prev) =>
        prev.some((m) => m.id === row.id)
          ? prev
          : [
              ...prev,
              {
                id: row.id!,
                channel: row.channel ?? "email",
                direction: (row.direction ?? "inbound") as ThreadMessage["direction"],
                status: row.status ?? "received",
                body: row.body_format === "html" ? (plain ?? row.body ?? "") : (row.body ?? ""),
                subject: null,
                occurredAt: row.occurred_at ?? new Date().toISOString(),
                scheduledFor: row.scheduled_for ?? null,
                durationSeconds: row.duration_seconds ?? null,
                draftedByLight: false,
                stampedByName: null,
                isPendingDraft: row.direction === "outbound" && row.status === "pending_approval",
                sentHtml: row.body_format === "html" ? (row.body ?? null) : null,
              },
            ]
      );
      if (nearBottom) {
        requestAnimationFrame(() => {
          const after = messagesRef.current;
          if (after) after.scrollTop = after.scrollHeight;
        });
      }
    }
    window.addEventListener("rooshni:comm-change", onCommChange);
    return () => window.removeEventListener("rooshni:comm-change", onCommChange);
  }, [threadId]);

  // v2's draggable divider — clamp 250–520px.
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

  if (!list.rows.length) {
    return (
      <div className="glass mx-auto mt-10 max-w-[560px] rounded-2xl border-dashed p-9 text-center">
        <div className="mb-2 text-[28px]">◧</div>
        <h2 className="mb-2 font-display text-xl font-extrabold">
          No conversations yet — no channels connected
        </h2>
        <p className="mx-auto max-w-[46ch] text-sm text-ink-soft">
          Once email and WhatsApp are connected, every message lands here, threaded per contact.
          Light drafts; nothing sends without your stamp.
        </p>
        <div className="mt-3.5">
          <Link
            href="/settings?tab=integrations"
            className="inline-block rounded-md bg-accent px-3.5 py-2 text-[13px] font-semibold text-white shadow-panel"
          >
            Connect a channel — Settings → Integrations
          </Link>
        </div>
      </div>
    );
  }

  // Burst separators (Messenger's grouped timestamps): a centred label opens
  // each burst; a gap beyond BURST_GAP_MS starts a new one.
  const withSeparators: ({ kind: "sep"; at: string; key: string } | { kind: "msg"; m: ThreadMessage })[] =
    [];
  let prevAt: number | null = null;
  for (const m of messages) {
    const at = new Date(m.occurredAt).getTime();
    if (prevAt === null || at - prevAt > BURST_GAP_MS) {
      withSeparators.push({ kind: "sep", at: m.occurredAt, key: `sep-${m.id}` });
    }
    withSeparators.push({ kind: "msg", m });
    prevAt = at;
  }

  const returnTo = thread
    ? `/conversations?thread=${thread.id}${list.page > 1 ? `&lpage=${list.page}` : ""}`
    : "/conversations";

  return (
    <div className="flex min-h-[480px] flex-col" style={{ height: "calc(100dvh - 132px)" }}>
      <div
        ref={splitRef}
        className="glass flex min-h-0 flex-1 overflow-hidden rounded-xl"
      >
        {/* Thread list — full-screen on a phone until a thread is opened. */}
        <div style={{ width: listWidth }} className={cn("flex min-h-0 shrink-0", "max-[900px]:!w-full", explicitThread && "max-[900px]:hidden")}>
          <ThreadListPane list={list} selectedId={thread?.id ?? null} onOpen={openThread} />
        </div>

        {/* v2 divider — desktop only. */}
        <div
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize"
          onPointerDown={startDrag}
          className="flex w-2 shrink-0 cursor-col-resize items-center justify-center border-x border-rule bg-paper-deep text-[13px] text-ink-faint hover:bg-accent-tint max-[900px]:hidden"
        >
          ⋮
        </div>

        {/* Open thread — full-screen on a phone when explicitly opened. */}
        {thread ? (
          <div
            className={cn(
              "flex min-w-0 flex-1 flex-col bg-paper",
              !explicitThread && "max-[900px]:hidden"
            )}
          >
            <div className="flex flex-wrap items-center gap-2 border-b border-rule bg-panel px-3.5 py-2.5">
              {/* Messenger's back control — phone only; the list is behind it. */}
              <Link
                href={`/conversations${list.page > 1 ? `?lpage=${list.page}` : ""}`}
                aria-label="Back to conversations"
                className="hidden size-9 items-center justify-center rounded-md text-ink-soft hover:bg-paper max-[900px]:flex"
              >
                <ArrowLeft className="size-4.5" />
              </Link>
              <span className="flex size-6.5 items-center justify-center rounded-full border border-rule bg-paper-deep text-[10px] font-bold text-ink-soft">
                {initials(thread.contactName)}
              </span>
              <span className="text-sm font-bold">{thread.contactName}</span>
              {thread.enquiry ? (
                <>
                  <span className="font-mono text-[10px] tracking-wide text-ink-faint max-[560px]:hidden">
                    {thread.enquiry.title}
                    {thread.enquiry.stageLabel ? ` · ${thread.enquiry.stageLabel}` : ""}
                  </span>
                  <Link
                    href={`/enquiries/${thread.enquiry.id}`}
                    className="ml-auto font-mono text-[10.5px] font-semibold tracking-wide text-accent"
                  >
                    Open enquiry →
                  </Link>
                </>
              ) : (
                <span className="ml-auto" />
              )}
              {/* Session 16 (PR-A): the WA window, a fact in neutral chrome. */}
              {thread.channel === "whatsapp" ? (
                <span className="rounded border border-rule bg-paper-deep px-1.5 py-px font-mono text-[9px] tracking-wide text-ink-soft uppercase">
                  {thread.waServiceWindowExpiresAt &&
                  new Date(thread.waServiceWindowExpiresAt) > new Date()
                    ? `WA window open · closes ${formatWhen(thread.waServiceWindowExpiresAt)}`
                    : "WA window closed — template messages only"}
                </span>
              ) : null}
              <button
                type="button"
                title="Log a call"
                className="glass size-7.5 rounded-md text-[13px] text-ink-soft max-[560px]:hidden"
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
                className="glass size-7.5 rounded-md text-[13px] text-ink-soft max-[560px]:hidden"
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
                        <div className="px-2.5 pt-1.5 text-center font-mono text-[9px] tracking-[.08em] text-ink-faint uppercase">
                          as the client sees it
                        </div>
                      ) : null}
                      <div
                        ref={messagesRef}
                        onScroll={onMessagesScroll}
                        className={cn(
                          "flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto",
                          view === "phone" ? "px-2.5 pt-2.5 pb-3.5" : "gap-2.5 px-5 pt-4 pb-4.5 max-[560px]:px-3"
                        )}
                      >
                        {hasOlder ? (
                          <div className="self-center py-1 font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">
                            scroll up for older messages
                          </div>
                        ) : null}
                        {withSeparators.map((item) =>
                          item.kind === "sep" ? (
                            <div
                              key={item.key}
                              className="self-center py-0.5 font-mono text-[9px] tracking-[.08em] text-ink-faint uppercase"
                            >
                              {formatWhen(item.at)}
                            </div>
                          ) : (
                            <Bubble
                              key={item.m.id}
                              message={item.m}
                              thread={thread}
                              stamp={
                                item.m.isPendingDraft ? (draftStamps[item.m.id] ?? null) : null
                              }
                              returnTo={returnTo}
                            />
                          )
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Composer — pinned at the bottom (Messenger shape); direct
                    sends are decision-21 insert-at-approved. */}
                <div className="shrink-0 border-t border-rule bg-panel px-4 pt-2.5 pb-3 max-[560px]:px-3">
                  {["email", "whatsapp"].includes(thread.channel) ? (
                    <div className="mb-2 flex flex-wrap items-center gap-2 font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">
                      <span className={thread.autoDraftPaused ? "" : "light-text font-semibold"}>
                        ✦ auto-draft {thread.autoDraftPaused ? "paused" : "on"}
                      </span>
                      <form action={prefAction} className="inline">
                        <input type="hidden" name="threadId" value={thread.id} />
                        <input
                          type="hidden"
                          name="paused"
                          value={thread.autoDraftPaused ? "false" : "true"}
                        />
                        <button
                          type="submit"
                          disabled={prefPending}
                          className="cursor-pointer rounded border border-rule bg-paper px-1.5 py-px uppercase hover:border-accent"
                          title={
                            thread.autoDraftPaused
                              ? "Resume automatic drafting on this conversation"
                              : "Pause automatic drafting on this conversation — Ask Light remains the manual door"
                          }
                        >
                          {thread.autoDraftPaused ? "resume" : "pause"}
                        </button>
                      </form>
                      <span className="max-[560px]:hidden">·</span>
                      <form action={settleAction} className="inline-flex items-center gap-1">
                        <input type="hidden" name="threadId" value={thread.id} />
                        <label>
                          settle{" "}
                          <select
                            name="override_minutes"
                            defaultValue={
                              thread.settleOverrideSeconds === null
                                ? "default"
                                : String(thread.settleOverrideSeconds / 60)
                            }
                            onChange={(e) => e.currentTarget.form?.requestSubmit()}
                            className="cursor-pointer rounded border border-rule bg-paper px-1 py-px font-mono text-[9.5px] uppercase"
                            title="How long Light waits after a client message before drafting — this conversation only"
                          >
                            <option value="default">business default</option>
                            <option value="0">instant</option>
                            <option value="1">1 min</option>
                            <option value="3">3 min</option>
                            <option value="5">5 min</option>
                          </select>
                        </label>
                      </form>
                      {thread.settleDueAt ? (
                        <span title="A client message is settling — Light drafts when the window closes">
                          · settling — drafts {formatWhen(thread.settleDueAt)}
                        </span>
                      ) : null}
                      <form action={askAction} className="ml-auto inline">
                        <input type="hidden" name="threadId" value={thread.id} />
                        <button
                          type="submit"
                          disabled={askPending}
                          className="light-btn-soft min-h-9 cursor-pointer rounded-md px-2.5 py-1 font-mono text-[9.5px] font-semibold tracking-wide uppercase"
                          title="Skip the remaining settle wait — Light drafts against the full thread now; the draft still needs your stamp"
                        >
                          {askPending ? "✦ drafting…" : "✦ Ask Light to draft"}
                        </button>
                      </form>
                    </div>
                  ) : null}
                  <div className="mb-2 inline-flex gap-1 rounded-lg bg-paper-deep p-0.5">
                    <button
                      type="button"
                      onClick={() => setMode("direct")}
                      className={cn(
                        "flex min-h-9 items-center gap-1.5 rounded-md px-3 py-1.5 font-mono text-[10px] font-semibold tracking-wide uppercase",
                        mode === "direct" ? "bg-panel text-ink shadow-panel" : "text-ink-soft"
                      )}
                    >
                      ✍ Message directly
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode("light")}
                      className={cn(
                        "flex min-h-9 items-center gap-1.5 rounded-md px-3 py-1.5 font-mono text-[10px] font-semibold tracking-wide uppercase",
                        mode === "light" ? "light-chip" : "text-ink-soft"
                      )}
                    >
                      ✦ Brief Light
                    </button>
                  </div>
                  <form action={sendAction} className="flex items-end gap-2">
                    <input type="hidden" name="threadId" value={thread.id} />
                    <button
                      type="button"
                      title="Attach"
                      className="glass size-9.5 shrink-0 rounded-lg text-ink-soft"
                      onClick={() =>
                        setNotice(
                          "Manual attach — same control as the Approval Inbox draft editor; arrives with its session."
                        )
                      }
                    >
                      <Paperclip className="mx-auto size-4" />
                    </button>
                    <textarea
                      ref={boxRef}
                      name="body"
                      rows={1}
                      placeholder={
                        mode === "direct"
                          ? `Message ${thread.contactName.split(" ")[0]} directly on ${CHANNEL_LABELS[thread.channel] ?? thread.channel}…`
                          : "Tell Light what you want said — e.g. “offer her Thursday, mention the payslips”…"
                      }
                      className={cn(
                        "min-h-11 flex-1 resize-none rounded-lg border px-3 py-2.5 text-[13px] text-ink outline-none focus:outline-2 focus:-outline-offset-1",
                        mode === "light"
                          ? "light-panel focus:outline-gold"
                          : "border-rule bg-paper focus:outline-accent"
                      )}
                    />
                    {mode === "direct" ? (
                      <button
                        type="submit"
                        disabled={sendPending}
                        className="h-9.5 shrink-0 rounded-lg bg-accent px-4 text-[13px] font-bold text-white disabled:opacity-60"
                      >
                        {sendPending ? "Sending…" : "Send"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          setNotice(
                            "Briefing Light with an instruction arrives with its session — use ✦ Ask Light to draft above for a reply against the thread as it stands. Nothing was drafted, nothing was recorded."
                          )
                        }
                        className="light-btn h-9.5 shrink-0 rounded-lg px-4 text-[13px] font-bold text-white"
                      >
                        ✦ Draft it
                      </button>
                    )}
                  </form>
                  <p className="mt-1.5 font-mono text-[9.5px] tracking-[.04em] text-ink-faint">
                    {actionError ? (
                      <span className="text-stamp">{actionError}</span>
                    ) : notice ? (
                      <span className="text-amber">{notice}</span>
                    ) : askState.done ? (
                      <span className="light-text font-semibold">
                        ✦ Light drafted against the full thread — the draft is in this thread and
                        your Approval Inbox, awaiting your stamp
                      </span>
                    ) : sendState.done ? (
                      <span className="text-ledger">
                        Sent as you · on The Record · any pending draft on this thread was
                        superseded (the human always wins)
                      </span>
                    ) : mode === "direct" ? (
                      <>
                        Sends immediately as <b className="text-ink-soft">you</b> · logged on The
                        Record · a pending Light draft on this thread is superseded by your reply
                      </>
                    ) : (
                      <>
                        <span className="light-text font-semibold">Light drafts from your brief</span>{" "}
                        · the draft lands in this thread and your Approval Inbox ·{" "}
                        <b className="text-stamp">nothing sends without a stamp</b>
                      </>
                    )}
                  </p>
                </div>
              </div>

              {/* Contact rail — Messenger's details pane. */}
              {railOpen ? (
                <div className="w-[250px] shrink-0 overflow-y-auto border-l border-rule bg-panel max-[1100px]:hidden">
                  <div className="border-b border-rule px-3.5 pt-3 pb-2.5">
                    <div className="flex items-center gap-1.5 text-sm font-bold">
                      {thread.contactName}
                      <span
                        className={cn(
                          "rounded-lg border px-1.5 py-px font-mono text-[9px] tracking-wide uppercase",
                          thread.contact.isClient
                            ? "border-ledger-line bg-ledger-tint text-ledger"
                            : "border-rule bg-paper-deep text-ink-soft"
                        )}
                      >
                        {thread.contact.status === "junk"
                          ? "Junk"
                          : thread.contact.isClient
                            ? "Client"
                            : "Lead"}
                      </span>
                    </div>
                  </div>
                  <div className="border-b border-dashed border-rule px-3.5 py-2.5">
                    {(
                      [
                        ["Phone", thread.contact.phone ?? "—"],
                        ["Email", thread.contact.email ?? "—"],
                        [
                          "Source",
                          thread.contact.source
                            ? thread.contact.source === "meta"
                              ? "Meta"
                              : thread.contact.source
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
                    {thread.contact.consents.length ? (
                      thread.contact.consents.map((c) => (
                        <div
                          key={c.channel}
                          className="flex items-start gap-1.5 py-0.5 text-[11.5px] text-ink-soft"
                        >
                          <span className={cn("font-bold", c.ok ? "text-accent" : "text-stamp")}>
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
                    href={`/contacts/${thread.contactId}`}
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
