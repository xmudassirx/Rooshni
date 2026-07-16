"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/*
 * view-memory, master mockup v2.
 *
 * JUDGMENT: Spec 2's memory_cards table has never been migrated — there is
 * no memory store in @rooshni/db. Per the session's data-wiring rule the
 * cards grid, tray and working-memory strip render their HONEST EMPTY
 * STATES; the import modal stubs its parsing to a proposals-shaped fixture
 * (explicitly permitted in scope), and confirming a stub proposal says
 * plainly that nothing was saved. (Session 8, Lane B.)
 */

interface StubProposal {
  id: string;
  text: string;
  why: string;
}

const SCOPE_FILTERS = ["All scopes", "Me"] as const;
const KIND_FILTERS = ["All kinds", "Facts", "Preferences", "Standards", "Methods"] as const;

export function MemoryClient({ businessName }: { businessName: string }) {
  const [proposals, setProposals] = useState<StubProposal[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  // v2 ships the paste box prefilled with a sample — editable input material
  // for the stub, never displayed as data.
  const [pasteText, setPasteText] = useState(
    "Prefers concise answers without preamble. Runs an immigration law firm in Manchester. Interested in AI tools for business automation. Writes in British English."
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [scope, setScope] = useState(0);
  const [kind, setKind] = useState(0);

  function runImportStub() {
    const claims = pasteText
      .split(/[.\n]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 8)
      .slice(0, 6);
    if (!claims.length) {
      setNotice("Paste some memory text first — each sentence becomes one proposal.");
      return;
    }
    setProposals(
      claims.map((text, i) => ({
        id: `stub-${Date.now()}-${i}`,
        text,
        why: "IMPORTED FROM PASTED TEXT · UI STUB — LIGHT'S PARSING AND THE MEMORY STORE ARRIVE WITH SPEC 2'S SESSION",
      }))
    );
    setImportOpen(false);
    setNotice(
      `${claims.length} claim${claims.length === 1 ? "" : "s"} extracted as proposals — a UI stub: nothing enters memory, because no memory store exists yet.`
    );
  }

  function resolveProposal(id: string) {
    setProposals((prev) => prev.filter((p) => p.id !== id));
    setNotice(
      "Nothing was saved — the memory store (Spec 2) is a later session; proposals here only demonstrate the tray."
    );
  }

  const scopes = [...SCOPE_FILTERS, businessName];

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
        <Button onClick={() => setImportOpen(true)}>⇪ Import memories</Button>
        <Button
          variant="primary"
          onClick={() =>
            setNotice(
              "Manual cards are born core + authoritative — creation arrives with the memory store (Spec 2's session)."
            )
          }
        >
          + Add card
        </Button>
      </div>
      {notice ? (
        <p className="mb-2.5 font-mono text-[10.5px] tracking-wide text-amber uppercase">
          {notice}
        </p>
      ) : null}

      {/* Proposals tray — Light asks before it remembers. */}
      <div className="light-panel mb-4 rounded-xl px-4 py-3.5">
        <h2 className="light-head mb-2.5 font-mono text-[10.5px] font-semibold tracking-[.14em] uppercase">
          ✦ Proposals — Light asks before it remembers
        </h2>
        {proposals.length ? (
          proposals.map((p) => (
            <div key={p.id} className="glass mb-2 rounded-lg px-3.5 py-2.5 last:mb-0">
              <div className="text-[13.5px]">
                Save as a memory: <b>&ldquo;{p.text}&rdquo;</b>
              </div>
              <div className="mt-0.5 font-mono text-[10.5px] text-ink-faint">{p.why}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="gold" onClick={() => resolveProposal(p.id)}>
                  Confirm — remember it
                </Button>
                <Button size="sm" onClick={() => resolveProposal(p.id)}>
                  Discard
                </Button>
              </div>
            </div>
          ))
        ) : (
          <p className="text-[13px] text-ink-soft">
            The tray is empty — Light has nothing to ask. Proposals appear here
            when Light observes a pattern worth remembering, and nothing enters
            memory unvouched.
          </p>
        )}
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {scopes.map((s, i) => (
          <button
            key={s}
            type="button"
            onClick={() => setScope(i)}
            className={cn(
              "rounded-2xl border px-3 py-1 font-mono text-[11px] font-semibold tracking-wide uppercase",
              scope === i ? "border-ink bg-ink text-paper" : "border-rule bg-panel text-ink-soft"
            )}
          >
            {s}
          </button>
        ))}
        <span className="mx-1 h-4.5 w-px bg-rule" />
        {KIND_FILTERS.map((k, i) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(i)}
            className={cn(
              "rounded-2xl border px-3 py-1 font-mono text-[11px] font-semibold tracking-wide uppercase",
              kind === i ? "border-ink bg-ink text-paper" : "border-rule bg-panel text-ink-soft"
            )}
          >
            {k}
          </button>
        ))}
      </div>

      {/* Cards grid — no memory_cards table exists; the grid says so. */}
      <div className="glass rounded-2xl border-dashed p-9 text-center">
        <h2 className="mb-2 font-display text-xl font-extrabold">
          Light holds no memories yet
        </h2>
        <p className="mx-auto max-w-[46ch] text-sm text-ink-soft">
          Every card — fact, preference, standard, method — will sit here with
          its scope, trust level and provenance, nothing hidden and everything
          editable. The memory store is Spec 2&rsquo;s table and it has not been
          built yet; an empty grid is the truth.
        </p>
        <span className="mt-3 inline-block rounded-md border border-accent bg-accent-tint px-3 py-1 font-mono text-[11px] font-semibold tracking-wide text-accent uppercase">
          Spec 2 · a later session
        </span>
      </div>

      {/* Working memory */}
      <div className="mt-5 rounded-xl border-[1.5px] border-dashed border-rule bg-paper-deep px-4 py-3">
        <h2 className="mb-2 font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-faint uppercase">
          Working memory — fades unless it earns promotion
        </h2>
        <p className="text-[13px] text-ink-soft">
          Nothing is being watched — working-memory observations arrive with the
          memory engine, expire on their own clock, and are promoted only through
          the tray above.
        </p>
      </div>

      <p className="mt-3.5 font-mono text-xs text-ink-faint">
        EVERY TIME LIGHT USES A CARD, THE LEDGER RECORDS WHICH CARDS FED WHICH DRAFT —
        &ldquo;WHY DID LIGHT SAY THAT?&rdquo; IS ALWAYS ANSWERABLE. · FULL EXPORT LIVES IN
        SETTINGS → DATA (OWNER ONLY, ON THE RECORD).
      </p>

      {importOpen ? (
        <>
          <button
            type="button"
            aria-label="Close"
            className="fixed inset-0 z-80 bg-ink/45"
            onClick={() => setImportOpen(false)}
          />
          <div
            role="dialog"
            aria-label="Import memories"
            className="glass fixed top-1/2 left-1/2 z-81 w-[min(520px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-2xl p-5 shadow-[0_20px_60px_rgba(32,43,56,.3)]"
          >
            <h3 className="font-display text-[19px] font-extrabold">Import memories</h3>
            <p className="mt-1.5 mb-3.5 text-[13px] text-ink-soft">
              From Claude, ChatGPT, or anywhere. Light reads what you give it and
              turns each claim into a <b>proposal</b> — nothing enters memory
              until you confirm it.
            </p>
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder="Paste memory text here — e.g. copied from ChatGPT's 'Manage memories' page…"
              className="h-24 w-full resize-y rounded-lg border border-rule bg-paper px-3 py-2.5 font-mono text-xs text-ink outline-none focus:outline-2 focus:outline-accent"
            />
            <button
              type="button"
              className="mt-2.5 flex w-full cursor-pointer flex-col gap-1 rounded-xl border-[1.5px] border-dashed border-rule p-4 text-center text-[13px] text-ink-soft light-drop"
              onClick={() =>
                setNotice(
                  "Screenshot reading is Light's — it arrives with the memory engine session."
                )
              }
            >
              <span>⇪ or drop screenshots here</span>
              <span className="font-mono text-[10px] text-ink-faint">
                e.g. a screenshot of ChatGPT&rsquo;s memory list — Light reads images natively
              </span>
            </button>
            <div className="mt-3.5 flex justify-end gap-2">
              <Button onClick={() => setImportOpen(false)}>Cancel</Button>
              <Button variant="gold" onClick={runImportStub}>
                ✦ Convert to memory proposals
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
