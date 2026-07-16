import { PageHead } from "@/components/shell/page-head";

import { FeedbackDemo } from "./feedback-demo";

/*
 * view-feedback, master mockup v2 — a grant-gated surface (the nav item
 * exists only for grant-holders; see the gate in the shell layout). No
 * feedback rows exist: the KPIs and the responses list are honest not-yets;
 * the client-side thumbs flow renders as the labelled demonstration it is.
 */

function KpiBox({ label, sub }: { label: string; sub: string }) {
  return (
    <div className="glass rounded-lg px-3.5 py-3">
      <div className="font-mono text-[9.5px] tracking-[.12em] text-ink-faint uppercase">
        {label}
      </div>
      <div className="my-1 font-display text-[26px] font-extrabold text-ink-faint">—</div>
      <div className="text-[11.5px] leading-normal text-ink-soft">{sub}</div>
    </div>
  );
}

export default function FeedbackPage() {
  return (
    <>
      <PageHead
        title="Feedback"
        sub="What the people you serve tap and type — thumbs from emails, notes from the portal"
        actions={
          <span
            className="cursor-help self-center rounded border border-dashed border-stamp bg-stamp-tint px-2 py-0.5 font-mono text-[9.5px] font-bold tracking-[.1em] text-stamp uppercase"
            title="Visible only to actors holding the feedback grant — you, and whoever you grant it to in Team & Access."
          >
            Grant-gated surface
          </span>
        }
      />

      <div className="mb-4 grid grid-cols-4 gap-3 max-[860px]:grid-cols-2">
        <KpiBox label="Useful rate · 30d" sub="No taps yet" />
        <KpiBox label="Responses" sub="Typed answers after the tap" />
        <KpiBox label="Ideas flagged" sub="✦ Light clusters recurring asks" />
        <div className="glass rounded-lg px-3.5 py-3">
          <div className="font-mono text-[9.5px] tracking-[.12em] text-ink-faint uppercase">
            Sources
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {["Campaigns", "Portal", "Website"].map((s) => (
              <span
                key={s}
                className="rounded border border-rule bg-paper-deep px-1.5 py-0.5 font-mono text-[9.5px] font-bold tracking-wide text-ink-soft uppercase"
              >
                {s} · soon
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="glass mb-4 overflow-hidden rounded-xl">
        <h2 className="border-b border-rule bg-paper px-4 py-3 font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-soft uppercase">
          What the client sees · the thumbs in every campaign footer link to YOUR site&rsquo;s
          feedback form page (a form archetype) — try the flow
        </h2>
        <FeedbackDemo />
        <p className="px-4 pb-3.5 font-mono text-[9px] text-ink-faint uppercase">
          One tap, one question, done — no accounts, no friction. The answer lands here,
          linked to its campaign and, where known, its contact.
        </p>
      </div>

      <div className="glass overflow-hidden rounded-xl">
        <h2 className="border-b border-rule bg-paper px-4 py-3 font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-soft uppercase">
          Responses · newest first
        </h2>
        <div className="px-6 py-10 text-center">
          <h3 className="mb-1.5 font-display text-lg font-extrabold">No responses yet</h3>
          <p className="mx-auto max-w-[46ch] text-[13px] text-ink-soft">
            Answers write here and onto the contact&rsquo;s thread when known —
            the store arrives with the campaigns session, and Light clusters
            recurring themes into ideas.
          </p>
        </div>
      </div>

      <p className="mt-3 font-mono text-xs text-ink-faint">
        THE MODULE IS A LINK — THE FORM LIVES AS A PAGE ON YOUR SITE (FORM ARCHETYPE), SO
        IT&rsquo;S YOURS TO RESTYLE; ANSWERS WRITE HERE AND ONTO THE CONTACT&rsquo;S THREAD
        WHEN KNOWN. ACCESS IS A GRANT — THIS SURFACE AND ITS NAV ITEM EXIST ONLY FOR
        GRANT-HOLDERS. ✦ LIGHT CLUSTERS RECURRING THEMES INTO IDEAS; ACTING ON ONE IS A
        NORMAL GATED CHANGE.
      </p>
    </>
  );
}
