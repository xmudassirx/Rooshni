"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";

import { useAskLight } from "@/components/shell/ask-light";
import { Button } from "@/components/ui/button";
import { formatWhen } from "@/lib/format";
import type { NoteItem, NotesData } from "@/lib/server/queries";
import { cn } from "@/lib/utils";

import {
  confirmLinkAction,
  quickCaptureAction,
  shareToTeamAction,
  toggleCheckAction,
  type NoteActionState,
} from "./actions";

/*
 * view-notes, master mockup v2: no folders, ever. The rail is generated —
 * All notes, Inbox (= unlinked), then one row per engagement that holds a
 * confirmed link. Saved views (stored searches) have no backing store yet
 * and render an honest empty line.
 */

type Filter = { kind: "all" } | { kind: "inbox" } | { kind: "group"; key: string };

export function NotesClient({ data }: { data: NotesData }) {
  const { notes, groups } = data;
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [selectedId, setSelectedId] = useState<string | null>(notes[0]?.id ?? null);
  const [capture, setCapture] = useState<null | "quick" | "light">(null);
  const [captureText, setCaptureText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { openAsk } = useAskLight();

  const inboxIds = useMemo(
    () => new Set(notes.filter((n) => !n.links.some((l) => l.confirmed)).map((n) => n.id)),
    [notes]
  );

  const visible = useMemo(() => {
    if (filter.kind === "inbox") return notes.filter((n) => inboxIds.has(n.id));
    if (filter.kind === "group") {
      const group = groups.find((g) => g.key === filter.key);
      return notes.filter((n) => group?.noteIds.includes(n.id));
    }
    return notes;
  }, [notes, groups, filter, inboxIds]);

  const selected: NoteItem | null =
    visible.find((n) => n.id === selectedId) ?? visible[0] ?? null;

  function run(
    action: (prev: NoteActionState, fd: FormData) => Promise<NoteActionState>,
    fields: Record<string, string>,
    after?: () => void
  ) {
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.set(k, v);
      const result = await action({ error: null }, fd);
      if (result.error) setError(result.error);
      else after?.();
    });
  }

  const railBtn = (active: boolean) =>
    cn(
      "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px]",
      active ? "bg-accent font-semibold text-white" : "text-ink hover:bg-paper-deep"
    );

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
        <Button variant="gold" onClick={() => setCapture("light")}>
          ✦ Capture with Light
        </Button>
        <Button variant="primary" onClick={() => setCapture("quick")}>
          + Quick capture
        </Button>
      </div>
      {notice ? (
        <p className="mb-2 font-mono text-[10.5px] tracking-wide text-amber uppercase">{notice}</p>
      ) : null}
      {error ? (
        <p className="mb-2 font-mono text-[10.5px] tracking-wide text-stamp uppercase">{error}</p>
      ) : null}

      <div className="glass grid min-h-[520px] grid-cols-[210px_300px_1fr] overflow-hidden rounded-xl max-[1000px]:grid-cols-1">
        {/* Generated rail */}
        <div className="border-r border-rule px-2.5 py-3 max-[1000px]:border-r-0 max-[1000px]:border-b">
          <div className="px-2 pt-2 pb-1 font-mono text-[9px] tracking-[.18em] text-ink-faint uppercase">
            Captures
          </div>
          <button
            type="button"
            className={railBtn(filter.kind === "all")}
            onClick={() => setFilter({ kind: "all" })}
          >
            ▤ All notes
            <span className="ml-auto font-mono text-[10px] opacity-70">{notes.length}</span>
          </button>
          <button
            type="button"
            className={railBtn(filter.kind === "inbox")}
            onClick={() => setFilter({ kind: "inbox" })}
          >
            ⇩ Inbox
            <span className="ml-auto font-mono text-[10px] opacity-70">{inboxIds.size}</span>
          </button>
          <div className="px-2 pt-3 pb-1 font-mono text-[9px] tracking-[.18em] text-ink-faint uppercase">
            Engagements <span className="light-text tracking-normal normal-case">· generated</span>
          </div>
          {groups.length ? (
            groups.map((g) => (
              <button
                key={g.key}
                type="button"
                className={railBtn(filter.kind === "group" && filter.key === g.key)}
                onClick={() => setFilter({ kind: "group", key: g.key })}
              >
                <span className="truncate">{g.label}</span>
                <span className="ml-auto font-mono text-[10px] opacity-70">{g.noteIds.length}</span>
              </button>
            ))
          ) : (
            <p className="px-2.5 py-1 text-[11.5px] text-ink-faint">
              No rows yet — a row appears here the moment a note gains a confirmed
              link to an enquiry, and vanishes when the links do.
            </p>
          )}
          <div className="px-2 pt-3 pb-1 font-mono text-[9px] tracking-[.18em] text-ink-faint uppercase">
            Saved views <span className="light-text tracking-normal normal-case">· pseudo-folders</span>
          </div>
          <p className="px-2.5 py-1 text-[11.5px] text-ink-faint">
            A saved view is a stored search — none saved yet; the store arrives
            with its session.
          </p>
        </div>

        {/* Note list */}
        <div className="overflow-auto border-r border-rule max-[1000px]:border-r-0 max-[1000px]:border-b">
          {visible.length ? (
            visible.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => setSelectedId(n.id)}
                className={cn(
                  "block w-full border-b border-rule px-3.5 py-3 text-left hover:bg-paper-deep",
                  selected?.id === n.id && "bg-paper-deep shadow-[inset_3px_0_0_var(--accent)]"
                )}
              >
                <div className="mb-0.5 text-[13.5px] font-bold">{n.title}</div>
                <div className="line-clamp-2 text-xs text-ink-soft">
                  {n.blocks.map((b) => b.text).join(" · ") || "—"}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <span className="rounded border border-rule bg-paper px-1.5 py-px font-mono text-[10px] text-ink-soft">
                    {n.visibility}
                  </span>
                  {n.links.some((l) => l.proposedByLight && !l.confirmed) ? (
                    <span className="light-chip rounded px-1.5 py-px font-mono text-[10px] font-semibold">
                      ✦ link proposed
                    </span>
                  ) : null}
                </div>
              </button>
            ))
          ) : (
            <p className="p-5 text-center text-[12.5px] text-ink-soft">
              {filter.kind === "inbox"
                ? "The Inbox is empty — every note has found its home."
                : "No notes yet. Capture the first — it lands here, private, unlinked."}
            </p>
          )}
        </div>

        {/* Body */}
        <div className="flex min-w-0 flex-col px-5.5 py-4.5">
          {selected ? (
            <>
              <h3 className="mb-1 font-display text-[19px] font-extrabold">{selected.title}</h3>
              <div className="mb-3.5 font-mono text-[10px] tracking-[.05em] text-ink-faint uppercase">
                Captured {formatWhen(selected.createdAt)} ·{" "}
                {selected.visibility === "private"
                  ? "private — yours until promoted"
                  : "team-visible"}{" "}
                · type: note (content_items)
              </div>
              {selected.blocks.map((b, i) =>
                b.type === "check" ? (
                  <button
                    key={i}
                    type="button"
                    disabled={pending}
                    onClick={() => run(toggleCheckAction, { noteId: selected.id, index: String(i) })}
                    className="flex items-center gap-2 py-1 text-left text-[13.5px]"
                  >
                    <span
                      className={cn(
                        "flex size-4 items-center justify-center rounded border-[1.5px] text-[10px]",
                        b.done ? "border-ledger bg-ledger text-white" : "border-rule text-transparent"
                      )}
                    >
                      ✓
                    </span>
                    <span className={cn(b.done && "text-ink-faint line-through")}>{b.text}</span>
                  </button>
                ) : (
                  <p key={i} className="mb-3 max-w-[75ch] text-[13.5px] leading-relaxed">
                    {b.text}
                  </p>
                )
              )}
              <div className="mt-3.5 flex flex-wrap gap-2">
                {selected.links.map((l) =>
                  l.confirmed ? (
                    l.toType === "engagement" ? (
                      <Link
                        key={l.id}
                        href={`/enquiries/${l.toId}`}
                        className="rounded-md border border-rule bg-paper-deep px-2 py-1 font-mono text-[10px] font-semibold tracking-wide text-ink-soft uppercase"
                      >
                        ⇄ {l.label}
                      </Link>
                    ) : (
                      <span
                        key={l.id}
                        className="rounded-md border border-rule bg-paper-deep px-2 py-1 font-mono text-[10px] font-semibold tracking-wide text-ink-soft uppercase"
                      >
                        ⇄ {l.label}
                      </span>
                    )
                  ) : (
                    <button
                      key={l.id}
                      type="button"
                      disabled={pending}
                      onClick={() => run(confirmLinkAction, { linkId: l.id })}
                      className="light-btn-soft rounded-md px-2 py-1 font-mono text-[10px] font-semibold tracking-wide uppercase"
                    >
                      ✦ link to {l.label}? Confirm
                    </button>
                  )
                )}
                {!selected.links.length ? (
                  <span className="font-mono text-[10px] tracking-wide text-ink-faint uppercase">
                    Unlinked — sits in the Inbox until a link is made or proposed
                  </span>
                ) : null}
              </div>
              <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-rule pt-3.5">
                <Button
                  size="sm"
                  onClick={() =>
                    setNotice(
                      "Promote — to a task, memory card or content draft — arrives with the memory engine session."
                    )
                  }
                >
                  Promote ▾
                </Button>
                {selected.visibility === "private" ? (
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() => run(shareToTeamAction, { noteId: selected.id })}
                  >
                    Share to team
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  onClick={() =>
                    // v2 wiring: this button opens the Ask Light modal with a
                    // correction prefilled — corrections cascade, never delete.
                    openAsk(
                      `Earlier I linked the note "${selected.title}" to the wrong enquiry — fix it.`
                    )
                  }
                >
                  ✦ Correct a link
                </Button>
                <span className="ml-auto font-mono text-[9.5px] text-ink-faint uppercase">
                  Fleeting notes fade · useful ones get promoted — lifecycle mirrors memory
                </span>
              </div>
            </>
          ) : (
            <p className="m-auto max-w-[40ch] text-center text-[13px] text-ink-soft">
              Nothing selected. Notes are content_items of type note plus
              entity_links — capture one and structure generates itself.
            </p>
          )}
        </div>
      </div>

      <p className="mt-3 font-mono text-xs text-ink-faint">
        NOTES ARE CONTENT_ITEMS OF TYPE NOTE + ENTITY_LINKS — NO NEW PRIMITIVE, NO MANUAL
        FOLDERS (3.10). INBOX = NOTES WITH NO LINKS · GROUP COUNTS = CONFIRMED LINKS TO THAT
        ENGAGEMENT · MEMORY IS A SEPARATE STORE — A NOTE ONLY BECOMES A MEMORY CARD BY
        PROMOTION, THROUGH THE PROPOSALS TRAY, WITH YOUR CONFIRMATION.
      </p>

      {capture ? (
        <>
          <button
            type="button"
            aria-label="Close"
            className="fixed inset-0 z-90 bg-ink/40 backdrop-blur-xs"
            onClick={() => setCapture(null)}
          />
          <div
            role="dialog"
            aria-label={capture === "light" ? "Capture with Light" : "Quick capture"}
            className="glass fixed top-1/2 left-1/2 z-91 w-[min(620px,94vw)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[28px] shadow-[0_24px_80px_rgba(32,43,56,.22)]"
          >
            <div className="flex items-center gap-2 px-6 pt-4 font-mono text-[9.5px] font-bold tracking-[.16em] text-ink-faint uppercase">
              <span className="light-spark text-[13px]">✦</span>
              {capture === "light"
                ? "Capture with Light · say it or type it — nothing links without your confirmation"
                : "Quick capture · a private note lands in your Inbox, unlinked"}
            </div>
            <textarea
              autoFocus
              value={captureText}
              onChange={(e) => setCaptureText(e.target.value)}
              placeholder="e.g. “Note from the call — he's waiting on his CoS date from the sponsor, chase Thursday…”"
              className="min-h-32 w-full resize-none bg-transparent px-6 py-3.5 text-[15px] leading-relaxed text-ink outline-none placeholder:text-ink-faint"
            />
            <div className="flex items-center gap-1.5 border-t border-rule px-4.5 py-3.5">
              <button
                type="button"
                aria-label="Capture"
                disabled={pending}
                onClick={() => {
                  if (capture === "light") {
                    setNotice(
                      "Light's capture flow — stated links, mismatch detection — arrives with its wiring session. Use Quick capture to save the note itself."
                    );
                    setCapture(null);
                  } else {
                    run(quickCaptureAction, { text: captureText }, () => {
                      setCapture(null);
                      setCaptureText("");
                      setNotice("Captured — private, unlinked, in your Inbox.");
                    });
                  }
                }}
                className="light-btn ml-auto flex h-11 w-18 items-center justify-center rounded-3xl text-lg disabled:opacity-50"
              >
                ↑
              </button>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
