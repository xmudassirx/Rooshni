"use client";

import { useActionState, useState } from "react";
import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { formatWhen } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  addFactAction,
  addInstructionAction,
  deactivateEntryAction,
  editFactAction,
  editInstructionAction,
  promoteObservationAction,
  type MemoryActionState,
} from "./actions";

/*
 * Session 32 — Light's Memory (D181): FACTS and BEHAVIOUR. Everything Light
 * knows that is not a database fact lives here — readable, editable,
 * evented. Colour law: gold = Light's channel (observations are Light's
 * bookkeeping of your refusals), red never appears here (no stamp lives on
 * this screen — corrections are stamped in the Approval Inbox), neutral
 * mono for provenance.
 */

export interface MemoryEntryView {
  id: string;
  kind: string;
  title: string;
  body: string;
  active: boolean;
  why: string | null;
  surfaces: Array<{ surface: string; label: string; ref?: string | null; in_platform: boolean }>;
  createdBy: string;
  createdAt: string;
  law: string | null;
  factKey: string | null;
  fromRejection: boolean;
  promotedFrom: string | null;
  history: Array<{ id: string; body: string; why: string | null; createdBy: string; createdAt: string }>;
}

export interface SurfaceOption {
  surface: string;
  label: string;
  ref: string | null;
  in_platform: boolean;
}

const initialState: MemoryActionState = { error: null };

function Provenance({ entry }: { entry: MemoryEntryView }) {
  return (
    <div className="mt-1.5 font-mono text-[10px] tracking-wide text-ink-faint uppercase">
      {entry.fromRejection ? "from a rejection · " : ""}
      {entry.createdBy} · {formatWhen(entry.createdAt)}
      {entry.why ? <span className="normal-case"> — {entry.why}</span> : null}
    </div>
  );
}

function History({ entry }: { entry: MemoryEntryView }) {
  const [open, setOpen] = useState(false);
  if (!entry.history.length) return null;
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="cursor-pointer font-mono text-[10px] tracking-wide text-accent uppercase hover:underline"
      >
        {open ? "− hide history" : `+ history (${entry.history.length} earlier ${entry.history.length === 1 ? "version" : "versions"})`}
      </button>
      {open ? (
        <ol className="mt-1.5 flex flex-col gap-1.5 border-l-2 border-rule pl-3">
          {entry.history.map((h) => (
            <li key={h.id}>
              <p className="text-[12.5px] text-ink-soft line-through decoration-rule">{h.body}</p>
              <div className="font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">
                {h.createdBy} · {formatWhen(h.createdAt)}
                {h.why ? <span className="normal-case"> — {h.why}</span> : null}
              </div>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function SurfaceChips({ entry }: { entry: MemoryEntryView }) {
  if (!entry.surfaces.length) {
    return (
      <div className="mt-1.5 font-mono text-[10px] tracking-wide text-ink-faint uppercase">
        No declared surfaces — a change ripples nowhere
      </div>
    );
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">Appears on:</span>
      {entry.surfaces.map((s, i) => (
        <span
          key={`${s.surface}-${s.ref ?? s.label}-${i}`}
          className={cn(
            "rounded-md border px-2 py-0.5 font-mono text-[9.5px] font-semibold tracking-wide uppercase",
            s.in_platform
              ? "border-accent bg-accent-tint text-accent"
              : "border-rule bg-paper-deep text-ink-soft"
          )}
          title={
            s.in_platform
              ? "In-platform — Light drafts the correction when this fact changes"
              : "External — a change here raises a manual task naming what is owed"
          }
        >
          {s.label}
          {!s.in_platform ? " · manual" : ""}
        </span>
      ))}
    </div>
  );
}

/** The surfaces editor: in-platform refs come from real options only. */
function SurfacesEditor({
  value,
  onChange,
  options,
}: {
  value: SurfaceOption[];
  onChange: (next: SurfaceOption[]) => void;
  options: SurfaceOption[];
}) {
  const [externalLabel, setExternalLabel] = useState("");
  const available = options.filter(
    (o) => !value.some((v) => v.surface === o.surface && v.ref === o.ref)
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {value.map((s, i) => (
          <button
            key={`${s.surface}-${s.ref ?? s.label}-${i}`}
            type="button"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
            title="Remove this surface"
            className={cn(
              "cursor-pointer rounded-md border px-2 py-0.5 font-mono text-[9.5px] font-semibold tracking-wide uppercase",
              s.in_platform ? "border-accent bg-accent-tint text-accent" : "border-rule bg-paper-deep text-ink-soft"
            )}
          >
            {s.label} ✕
          </button>
        ))}
        {value.length === 0 ? (
          <span className="text-[12px] text-ink-soft">No surfaces declared yet.</span>
        ) : null}
      </div>
      {available.length ? (
        <select
          className="w-full rounded-lg border border-rule bg-paper px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:outline-2 focus:outline-accent"
          value=""
          onChange={(e) => {
            const idx = Number(e.target.value);
            if (!Number.isNaN(idx) && available[idx]) onChange([...value, available[idx]]);
          }}
        >
          <option value="" disabled>
            + add an in-platform surface (templates, knowledge entries)…
          </option>
          {available.map((o, i) => (
            <option key={`${o.surface}-${o.ref}`} value={i}>
              {o.label}
            </option>
          ))}
        </select>
      ) : null}
      <div className="flex gap-2">
        <input
          value={externalLabel}
          onChange={(e) => setExternalLabel(e.target.value)}
          placeholder="External surface, e.g. Google Business Profile"
          className="min-w-0 flex-1 rounded-lg border border-rule bg-paper px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:outline-2 focus:outline-accent"
        />
        <Button
          type="button"
          size="sm"
          disabled={!externalLabel.trim()}
          onClick={() => {
            onChange([
              ...value,
              {
                surface: externalLabel.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_"),
                label: externalLabel.trim(),
                ref: null,
                in_platform: false,
              },
            ]);
            setExternalLabel("");
          }}
        >
          + external
        </Button>
      </div>
      <p className="font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">
        In-platform surfaces get drafted corrections; external ones get manual tasks. Website surfaces arrive with the website session.
      </p>
    </div>
  );
}

function FactCard({ entry, options }: { entry: MemoryEntryView; options: SurfaceOption[] }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(entry.body);
  const [surfaces, setSurfaces] = useState<SurfaceOption[]>(
    entry.surfaces.map((s) => ({ surface: s.surface, label: s.label, ref: s.ref ?? null, in_platform: s.in_platform }))
  );
  const [state, formAction, pending] = useActionState(editFactAction, initialState);

  return (
    <div className="glass rounded-xl px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-faint uppercase">
            {entry.title}
          </h3>
          <p className="mt-0.5 text-[14.5px] font-semibold break-words text-ink">{entry.body}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setEditing((v) => !v)}>
          {editing ? "Cancel" : "Edit"}
        </Button>
      </div>
      <SurfaceChips entry={entry} />
      <Provenance entry={entry} />
      <History entry={entry} />
      {state.sweepNote ? (
        <p className="mt-2 rounded-lg border border-gold/50 bg-gold-tint px-3 py-2 text-[12.5px] text-ink">
          <Sparkles className="mr-1 inline size-3.5 text-gold" aria-hidden />
          {state.sweepNote} Corrections await your stamp in the Approval Inbox — nothing applies itself.
        </p>
      ) : null}
      {editing ? (
        <form action={formAction} className="mt-2.5 flex flex-col gap-2 border-t border-dashed border-rule pt-2.5">
          <input type="hidden" name="entryId" value={entry.id} />
          <input type="hidden" name="surfaces" value={JSON.stringify(surfaces)} />
          <label className="font-mono text-[9.5px] tracking-wide text-ink-faint uppercase" htmlFor={`fact-${entry.id}`}>
            New value — the edit supersedes, history stands
          </label>
          <input
            id={`fact-${entry.id}`}
            name="value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-full rounded-lg border border-rule bg-paper px-2.5 py-1.5 text-[13px] text-ink outline-none focus:outline-2 focus:outline-accent"
          />
          <SurfacesEditor value={surfaces} onChange={setSurfaces} options={options} />
          {state.error ? <p className="text-[12.5px] text-stamp">{state.error}</p> : null}
          <div className="flex gap-2">
            <Button size="sm" variant="primary" disabled={pending || !value.trim()}>
              {pending ? "Saving…" : "Save — supersede and sweep"}
            </Button>
            <DeactivateControl entryId={entry.id} label="Retire this fact" />
          </div>
        </form>
      ) : null}
    </div>
  );
}

function DeactivateControl({ entryId, label }: { entryId: string; label: string }) {
  const [state, formAction, pending] = useActionState(deactivateEntryAction, initialState);
  return (
    <form action={formAction} className="contents">
      <input type="hidden" name="entryId" value={entryId} />
      <Button size="sm" variant="ghost" disabled={pending} type="submit">
        {pending ? "Retiring…" : label}
      </Button>
      {state.error ? <span className="text-[12px] text-stamp">{state.error}</span> : null}
    </form>
  );
}

function InstructionCard({ entry }: { entry: MemoryEntryView }) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(entry.body);
  const [state, formAction, pending] = useActionState(editInstructionAction, initialState);

  return (
    <div className="glass rounded-xl px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-faint uppercase">
            {entry.title}
          </h3>
          <p className="mt-0.5 text-[13.5px] break-words text-ink">{entry.body}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setEditing((v) => !v)}>
          {editing ? "Cancel" : "Edit"}
        </Button>
      </div>
      {entry.law ? (
        // Q3 ruling: an instruction that mirrors a law is editable as prose,
        // but its floor is the deterministic screen — the surface says so.
        <div className="mt-1.5 font-mono text-[10px] tracking-wide text-ink-faint uppercase">
          Enforced by pre-flight ({entry.law}) — editing or deactivating this softens the steering, never the law
        </div>
      ) : null}
      {entry.promotedFrom ? (
        <div className="mt-1.5 font-mono text-[10px] tracking-wide text-ink-faint uppercase">
          Promoted from an observation — your act, on The Record
        </div>
      ) : null}
      <Provenance entry={entry} />
      <History entry={entry} />
      {editing ? (
        <form action={formAction} className="mt-2.5 flex flex-col gap-2 border-t border-dashed border-rule pt-2.5">
          <input type="hidden" name="entryId" value={entry.id} />
          <Textarea name="body" value={body} onChange={(e) => setBody(e.target.value)} />
          {state.error ? <p className="text-[12.5px] text-stamp">{state.error}</p> : null}
          <div className="flex gap-2">
            <Button size="sm" variant="primary" disabled={pending || !body.trim()}>
              {pending ? "Saving…" : "Save — rides the next draft"}
            </Button>
            <DeactivateControl entryId={entry.id} label="Deactivate" />
          </div>
        </form>
      ) : null}
    </div>
  );
}

function ObservationCard({ entry }: { entry: MemoryEntryView }) {
  const [state, formAction, pending] = useActionState(promoteObservationAction, initialState);
  return (
    // Gold: an observation is Light's bookkeeping of your refusal.
    <div className="light-panel rounded-xl px-4 py-3">
      <p className="text-[13.5px] text-ink">{entry.body}</p>
      <Provenance entry={entry} />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <form action={formAction}>
          <input type="hidden" name="observationId" value={entry.id} />
          <Button size="sm" variant="gold" disabled={pending} type="submit">
            <Sparkles /> {pending ? "Promoting…" : "Promote to standing instruction"}
          </Button>
        </form>
        <DeactivateControl entryId={entry.id} label="Dismiss" />
        {state.error ? <span className="w-full text-[12px] text-stamp">{state.error}</span> : null}
      </div>
    </div>
  );
}

function AddFactDialog({ open, onClose, options }: { open: boolean; onClose: () => void; options: SurfaceOption[] }) {
  const [state, formAction, pending] = useActionState(addFactAction, initialState);
  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [surfaces, setSurfaces] = useState<SurfaceOption[]>([]);
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a fact</DialogTitle>
          <DialogDescription>
            A business fact Light may state exactly — with the list of surfaces it appears on, so a
            later change ripples everywhere it lives.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-3">
          <input type="hidden" name="surfaces" value={JSON.stringify(surfaces)} />
          <input
            name="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Name — e.g. Parking"
            className="w-full rounded-lg border border-rule bg-paper px-2.5 py-1.5 text-[13px] text-ink outline-none focus:outline-2 focus:outline-accent"
          />
          <input
            name="value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Value — e.g. Free parking behind the office, entrance on Hilton Street"
            className="w-full rounded-lg border border-rule bg-paper px-2.5 py-1.5 text-[13px] text-ink outline-none focus:outline-2 focus:outline-accent"
          />
          <SurfacesEditor value={surfaces} onChange={setSurfaces} options={options} />
          {state.error ? <p className="text-[12.5px] text-stamp">{state.error}</p> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button size="sm" variant="primary" disabled={pending || !title.trim() || !value.trim()}>
              {pending ? "Saving…" : "Add fact"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AddInstructionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [state, formAction, pending] = useActionState(addInstructionAction, initialState);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a standing instruction</DialogTitle>
          <DialogDescription>
            Rides every draft, verbatim, from the next composition — no build, no re-issue. The
            800-token ceiling refuses past the cap rather than silently degrading every draft.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-3">
          <input
            name="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Short name — e.g. Offer WhatsApp"
            className="w-full rounded-lg border border-rule bg-paper px-2.5 py-1.5 text-[13px] text-ink outline-none focus:outline-2 focus:outline-accent"
          />
          <Textarea
            name="body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="The instruction, as Light should follow it — e.g. Always offer WhatsApp as an alternative way to continue the conversation."
          />
          {state.error ? <p className="text-[12.5px] text-stamp">{state.error}</p> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button size="sm" variant="primary" disabled={pending || !title.trim() || !body.trim()}>
              {pending ? "Saving…" : "Add instruction"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function MemoryClient({
  facts,
  instructions,
  observations,
  retired,
  tokenCount,
  tokenCeiling,
  surfaceOptions,
}: {
  facts: MemoryEntryView[];
  instructions: MemoryEntryView[];
  observations: MemoryEntryView[];
  retired: MemoryEntryView[];
  tokenCount: number;
  tokenCeiling: number;
  surfaceOptions: SurfaceOption[];
}) {
  const [addFactOpen, setAddFactOpen] = useState(false);
  const [addInstructionOpen, setAddInstructionOpen] = useState(false);
  const [showRetired, setShowRetired] = useState(false);

  return (
    <>
      {/* FACTS */}
      <section className="mb-6">
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-faint uppercase">
            Facts — what is true about the business
          </h2>
          <Button size="sm" onClick={() => setAddFactOpen(true)}>
            + Add fact
          </Button>
        </div>
        {facts.length ? (
          <div className="grid gap-2.5 min-[860px]:grid-cols-2">
            {facts.map((f) => (
              <FactCard key={f.id} entry={f} options={surfaceOptions} />
            ))}
          </div>
        ) : (
          <div className="glass rounded-xl border-dashed px-4 py-5 text-center text-[13px] text-ink-soft">
            No facts yet. Add the first — opening hours, phone, booking link — and Light will state
            them exactly, everywhere they are declared.
          </div>
        )}
        <p className="mt-2 font-mono text-[10px] tracking-wide text-ink-faint uppercase">
          Editing a fact fires the ripple sweep: corrections drafted to the Approval Inbox for
          in-platform surfaces, manual tasks for external ones. Nothing applies without your stamp.
        </p>
      </section>

      {/* BEHAVIOUR */}
      <section className="mb-6">
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-faint uppercase">
            Behaviour — standing instructions
          </h2>
          <div className="flex items-center gap-2.5">
            <span
              className={cn(
                "font-mono text-[10px] tracking-wide uppercase",
                tokenCount > tokenCeiling * 0.9 ? "font-semibold text-stamp" : "text-ink-faint"
              )}
            >
              {tokenCount} / {tokenCeiling} tokens
            </span>
            <Button size="sm" onClick={() => setAddInstructionOpen(true)}>
              + Add instruction
            </Button>
          </div>
        </div>
        {instructions.length ? (
          <div className="flex flex-col gap-2.5">
            {instructions.map((i) => (
              <InstructionCard key={i.id} entry={i} />
            ))}
          </div>
        ) : (
          <div className="glass rounded-xl border-dashed px-4 py-5 text-center text-[13px] text-ink-soft">
            No standing instructions yet — each one you add rides every draft from the next
            composition.
          </div>
        )}
        <p className="mt-2 font-mono text-[10px] tracking-wide text-ink-faint uppercase">
          Active instructions ride every composition; the credit line names which entries rode each
          draft, so The Record answers &ldquo;why did Light say that&rdquo; by name.
        </p>
      </section>

      {/* OBSERVATIONS */}
      <section className="mb-6">
        <h2 className="mb-2.5 font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-faint uppercase">
          <Sparkles className="mr-1 inline size-3.5 text-gold" aria-hidden />
          Observations — what Light noticed from your rejections
        </h2>
        {observations.length ? (
          <div className="flex flex-col gap-2.5">
            {observations.map((o) => (
              <ObservationCard key={o.id} entry={o} />
            ))}
          </div>
        ) : (
          <div className="glass rounded-xl border-dashed px-4 py-5 text-center text-[13px] text-ink-soft">
            Nothing observed yet. When a draft is rejected with a reason, the reason lands here —
            promoting it to a standing instruction is one click, yours, on The Record. Light never
            writes its own instructions.
          </div>
        )}
      </section>

      {/* RETIRED */}
      {retired.length ? (
        <section className="mb-6">
          <button
            type="button"
            onClick={() => setShowRetired((v) => !v)}
            aria-expanded={showRetired}
            className="cursor-pointer font-mono text-[10px] tracking-wide text-accent uppercase hover:underline"
          >
            {showRetired ? "− hide retired entries" : `+ retired entries (${retired.length}) — history never deletes`}
          </button>
          {showRetired ? (
            <div className="mt-2 flex flex-col gap-2">
              {retired.map((r) => (
                <div key={r.id} className="rounded-xl border border-dashed border-rule bg-paper-deep px-4 py-2.5">
                  <div className="font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">
                    {r.kind} · {r.title}
                  </div>
                  <p className="text-[12.5px] text-ink-soft line-through decoration-rule">{r.body}</p>
                  <Provenance entry={r} />
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      <p className="mt-3.5 font-mono text-[10px] tracking-wide text-ink-faint uppercase">
        Memory history is append-only — an edit supersedes, never overwrites. Every entry, edit,
        promotion and sweep is a line on The Record.
      </p>

      <AddFactDialog open={addFactOpen} onClose={() => setAddFactOpen(false)} options={surfaceOptions} />
      <AddInstructionDialog open={addInstructionOpen} onClose={() => setAddInstructionOpen(false)} />
    </>
  );
}
