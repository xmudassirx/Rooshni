"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  archiveKnowledgeEntryAction,
  knowledgeAttachmentUrlAction,
  knowledgeEntryVersionsAction,
  publishKnowledgeEntryAction,
  saveKnowledgeEntryAction,
  type KnowledgeActionState,
} from "./actions";
import type { KnowledgeEntryRow, KnowledgeVocab } from "@/lib/server/queries";

/*
 * The Knowledge tab's client half (Session 15, PR-1): the create/edit
 * dialog and the per-entry publish/archive controls. Category and route
 * options render FROM the installed declaration passed down by the server
 * component — never from strings here.
 */

const INITIAL: KnowledgeActionState = { error: null };

function EntryDialog({
  vocab,
  entry,
  onClose,
}: {
  vocab: KnowledgeVocab;
  entry: KnowledgeEntryRow | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(saveKnowledgeEntryAction, INITIAL);
  const [category, setCategory] = useState(entry?.category ?? vocab.categories[0]?.key ?? "");

  useEffect(() => {
    if (state.saved) {
      onClose();
      router.refresh();
    }
  }, [state.saved, onClose, router]);

  return (
    <>
      <button type="button" aria-label="Close" className="modal-scrim fixed inset-0 z-90" onClick={onClose} />
      <div
        role="dialog"
        aria-label={entry ? "Edit knowledge entry" : "New knowledge entry"}
        className="modal-surface fixed top-1/2 left-1/2 z-91 w-[min(560px,93vw)] -translate-x-1/2 -translate-y-1/2 rounded-[28px] shadow-[0_24px_80px_rgba(32,43,56,.22)]"
      >
        <div className="px-6 pt-4 font-mono text-[9.5px] font-bold tracking-[.16em] text-ink-faint uppercase">
          {entry ? `Edit entry · v${entry.version} → v${entry.version + 1}` : "New knowledge entry"} · every
          change is a version on The Record
        </div>
        <form action={formAction} className="px-6 pt-3 pb-4">
          {entry ? <input type="hidden" name="id" value={entry.id} /> : null}
          <input
            autoFocus
            name="title"
            defaultValue={entry?.title ?? ""}
            placeholder="Title — e.g. Skilled Worker route, Published fees"
            className="w-full rounded-xl border-[1.5px] border-rule bg-paper px-3.5 py-2.5 text-[14px] text-ink outline-none focus:border-accent"
          />
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <span className="font-mono text-[9.5px] font-semibold tracking-[.14em] text-ink-faint uppercase">
              Category
            </span>
            <select
              name="category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="rounded-xl border-[1.5px] border-rule bg-paper px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent"
            >
              {vocab.categories.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
            {category === "service_description" || category === "route_guide" ? (
              <>
                <span className="font-mono text-[9.5px] font-semibold tracking-[.14em] text-ink-faint uppercase">
                  Route
                </span>
                <select
                  name="visa_route"
                  defaultValue={entry?.visaRoute ?? ""}
                  className="rounded-xl border-[1.5px] border-rule bg-paper px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent"
                >
                  <option value="">— pick a route —</option>
                  {vocab.routes.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </>
            ) : null}
          </div>
          {/* PR-i (Session 19) + founder ruling (1 Aug 2026): a guide document
              may ride ANY route-scoped entry — one route entry carrying text
              AND the PDF is the preferred shape. PDF only, 8MB ceiling
              (refused loudly at upload, at the stamp, and at dispatch alike). */}
          {category === "route_guide" || category === "service_description" ? (
            <label className="mt-2.5 block">
              <span className="mb-1 block font-mono text-[9.5px] font-semibold tracking-[.14em] text-ink-faint uppercase">
                {category === "route_guide"
                  ? "Document (PDF, up to 8MB)"
                  : "Guide document (optional PDF, up to 8MB)"}
              </span>
              <input
                type="file"
                name="file"
                accept="application/pdf,.pdf"
                className="w-full rounded-xl border-[1.5px] border-rule bg-paper px-3 py-2 text-[12.5px] text-ink file:mr-3 file:rounded-lg file:border-0 file:bg-paper-deep file:px-2.5 file:py-1 file:font-mono file:text-[10px] file:tracking-wide file:uppercase"
              />
              <span className="mt-1 block text-[11px] text-ink-faint">
                {entry?.file
                  ? `Current document: ${entry.file.filename} (${(entry.file.sizeBytes / 1024 / 1024).toFixed(1)}MB) — uploading a new one replaces it (the old file is archived, never deleted).`
                  : "Once published, Light attaches this document to intro emails for its route. No file, no attachment — never a placeholder."}
              </span>
            </label>
          ) : null}
          <Textarea
            name="body"
            defaultValue={entry?.bodyText ?? ""}
            rows={category === "route_guide" ? 3 : 9}
            placeholder={
              category === "route_guide"
                ? "Optional note about this guide (for your team — Light does not read it into drafts)."
                : "Plain text — this is what Light reads. Published fees belong here word for word; Light may never quote an amount you have not published."
            }
            className="mt-2.5 text-[13px]"
          />
          {state.error ? <p className="mt-2 text-[12px] text-stamp">{state.error}</p> : null}
          <div className="mt-3 flex items-center gap-2">
            <p className="text-[11px] text-ink-faint">
              Saved entries start as drafts — Light reads an entry only once you publish it.
            </p>
            <Button type="submit" variant="primary" className="ml-auto" disabled={pending}>
              {pending ? "Saving…" : entry ? "Save new version" : "Create draft"}
            </Button>
          </div>
        </form>
      </div>
    </>
  );
}

/**
 * Session 23 (WS5b, founder-reported) — the READ view: clicking the title
 * opens the entry read-only (full text, the attachment with open/download,
 * version history), with Edit as an ACTION from there. Editing is no longer
 * the only door into an entry.
 */
export function EntryTitle({ entry, vocab }: { entry: KnowledgeEntryRow; vocab: KnowledgeVocab }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [versions, setVersions] = useState<
    { version: number; savedAt: string; preview: string }[] | null
  >(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const routeLabel = entry.visaRoute
    ? (vocab.routes.find((r) => r.key === entry.visaRoute)?.label ?? entry.visaRoute)
    : null;

  useEffect(() => {
    if (!open || versions !== null) return;
    void knowledgeEntryVersionsAction(entry.id).then((res) => {
      setVersions(res.versions);
      setVersionsError(res.error);
    });
  }, [open, versions, entry.id]);

  async function openAttachment() {
    if (!entry.file) return;
    setFileError(null);
    const res = await knowledgeAttachmentUrlAction(entry.file.id);
    if (res.url) window.open(res.url, "_blank", "noopener");
    else setFileError(res.error ?? "The download failed.");
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="cursor-pointer text-left text-[13px] font-medium text-ink hover:text-accent hover:underline"
      >
        {entry.title}
      </button>
      {open && !editing ? (
        <>
          <button
            type="button"
            aria-label="Close"
            className="modal-scrim fixed inset-0 z-90"
            onClick={() => setOpen(false)}
          />
          <div
            role="dialog"
            aria-label={`Knowledge entry: ${entry.title}`}
            className="modal-surface fixed top-1/2 left-1/2 z-91 flex max-h-[86vh] w-[min(620px,93vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[28px] shadow-[0_24px_80px_rgba(32,43,56,.22)]"
          >
            <div className="px-6 pt-4 pb-2">
              <div className="font-mono text-[9.5px] font-bold tracking-[.16em] text-ink-faint uppercase">
                Knowledge entry · read-only · v{entry.version}
              </div>
              <h2 className="mt-1 font-display text-lg font-extrabold">{entry.title}</h2>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-[10px] tracking-wide uppercase">
                {routeLabel ? (
                  <span className="rounded border border-rule bg-paper-deep px-1.5 py-px text-ink-soft">
                    {routeLabel}
                  </span>
                ) : null}
                {entry.state === "published" ? (
                  <span className="rounded border border-ledger-line bg-ledger-tint px-1.5 py-px text-ledger">
                    Published — Light reads this
                  </span>
                ) : (
                  <span className="rounded border border-rule bg-paper-deep px-1.5 py-px text-ink-soft">
                    Draft — invisible to Light
                  </span>
                )}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto border-t border-dashed border-rule px-6 py-3">
              {entry.bodyText ? (
                <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-ink">
                  {entry.bodyText}
                </p>
              ) : (
                <p className="text-[12.5px] text-ink-faint">
                  No text — this entry is its document.
                </p>
              )}
              {entry.file ? (
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-rule bg-paper-deep px-3 py-2">
                  <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-ink-soft">
                    <Paperclip className="size-3 shrink-0" aria-hidden />
                    {entry.file.filename} · {(entry.file.sizeBytes / 1024 / 1024).toFixed(1)}MB
                  </span>
                  <Button size="sm" className="ml-auto" onClick={() => void openAttachment()}>
                    Open / download
                  </Button>
                  {fileError ? <span className="w-full text-[11px] text-stamp">{fileError}</span> : null}
                </div>
              ) : null}
              <div className="mt-4">
                <div className="mb-1.5 font-mono text-[9.5px] font-semibold tracking-[.14em] text-ink-faint uppercase">
                  Version history — every version retained, every change on The Record
                </div>
                {versions === null ? (
                  <p className="text-[11.5px] text-ink-faint">Reading the history…</p>
                ) : versionsError ? (
                  <p className="text-[11.5px] text-stamp">{versionsError}</p>
                ) : versions.length === 0 ? (
                  <p className="text-[11.5px] text-ink-faint">
                    No earlier versions — v{entry.version} is the first.
                  </p>
                ) : (
                  versions.map((v) => (
                    <div
                      key={v.version}
                      className="border-b border-dashed border-paper-deep py-1.5 last:border-b-0"
                    >
                      <span className="font-mono text-[10.5px] font-semibold text-ink-soft">
                        v{v.version} ·{" "}
                        {new Date(v.savedAt).toLocaleDateString("en-GB", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                      </span>
                      {v.preview ? (
                        <p className="mt-0.5 line-clamp-1 text-[11.5px] text-ink-faint">{v.preview}</p>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 border-t border-rule px-6 py-3">
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                Close
              </Button>
              <Button
                size="sm"
                variant="primary"
                className="ml-auto"
                onClick={() => setEditing(true)}
              >
                Edit — a new version
              </Button>
            </div>
          </div>
        </>
      ) : null}
      {editing ? (
        <EntryDialog
          vocab={vocab}
          entry={entry}
          onClose={() => {
            setEditing(false);
            setOpen(false);
            setVersions(null);
          }}
        />
      ) : null}
    </>
  );
}

export function NewEntryButton({ vocab }: { vocab: KnowledgeVocab }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
        New entry
      </Button>
      {open ? <EntryDialog vocab={vocab} entry={null} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function KnowledgeEntryControls({
  entry,
  vocab,
}: {
  entry: KnowledgeEntryRow;
  vocab: KnowledgeVocab;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [publishState, publishAction, publishPending] = useActionState(publishKnowledgeEntryAction, INITIAL);
  const [archiveState, archiveAction, archivePending] = useActionState(archiveKnowledgeEntryAction, INITIAL);

  useEffect(() => {
    if (publishState.saved || archiveState.saved) router.refresh();
  }, [publishState.saved, archiveState.saved, router]);

  return (
    <div className="flex shrink-0 flex-col items-end gap-1.5">
      <div className="flex items-center gap-1.5">
        <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
          edit
        </Button>
        {entry.state === "draft" ? (
          <form action={publishAction}>
            <input type="hidden" name="id" value={entry.id} />
            {/* Publishing is a human stamp (0009 + approvals.content) — the
                stamp act wears red, the published STATE wears green. */}
            <Button type="submit" variant="approve" size="sm" disabled={publishPending}>
              {publishPending ? "Publishing…" : "Publish"}
            </Button>
          </form>
        ) : null}
        {confirmingArchive ? (
          <form action={archiveAction}>
            <input type="hidden" name="id" value={entry.id} />
            <Button type="submit" variant="approve" size="sm" disabled={archivePending}>
              {archivePending ? "Archiving…" : "Confirm archive"}
            </Button>
          </form>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setConfirmingArchive(true)}>
            archive
          </Button>
        )}
      </div>
      {publishState.error ? <p className="text-[11px] text-stamp">{publishState.error}</p> : null}
      {archiveState.error ? <p className="text-[11px] text-stamp">{archiveState.error}</p> : null}
      {editing ? <EntryDialog vocab={vocab} entry={entry} onClose={() => setEditing(false)} /> : null}
    </div>
  );
}
