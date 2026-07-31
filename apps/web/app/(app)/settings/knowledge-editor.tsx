"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  archiveKnowledgeEntryAction,
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
            {category === "service_description" ? (
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
          <Textarea
            name="body"
            defaultValue={entry?.bodyText ?? ""}
            rows={9}
            placeholder="Plain text — this is what Light reads. Published fees belong here word for word; Light may never quote an amount you have not published."
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
