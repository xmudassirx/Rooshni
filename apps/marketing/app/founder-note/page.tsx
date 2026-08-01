import type { Metadata } from "next";
import Link from "next/link";
import { DEMO_PATH } from "@/lib/links";

export const metadata: Metadata = {
  title: "Founder note",
  description:
    "Why Barakah exists, from the founder: two hours a day of hand-walked follow-up in a real immigration practice, and the approval gate that fixed it.",
};

/*
 * Builder-drafted in the founder's voice per the session fence ("write full
 * real copy in the founder-note register; I will edit words at review").
 * The decision-111 precedent applies: the founder's own rewrite lands before
 * this page carries his signature to strangers; flagged in the close report.
 */

export default function FounderNotePage() {
  return (
    <section className="section">
      <div className="container" style={{ maxWidth: "44rem" }}>
      <p className="eyebrow">A note from the founder</p>
      <h1 style={{ marginTop: "0.8rem", fontSize: "clamp(2rem, 4.5vw, 2.9rem)" }}>
        Why I built an operating system for immigration firms.
      </h1>
      <div className="serif-prose prose" style={{ marginTop: "2rem" }}>
        <p>
          Barakah started inside a real UK immigration practice, not a pitch deck. I watched a
          principal spend around two hours every day walking a lead pipeline by hand. Fifty
          enquiries came in over eight days. A third were junk that still had to be opened and
          read. Not one consultation got booked from that batch. The tracking columns that
          were supposed to say who had been contacted, and when, were empty on every single
          row. Nobody was lazy. The tools were.
        </p>
        <p>
          The pipeline itself told the story. Four of its twelve columns were not stages of a
          legal matter at all. They were clocks: follow up in 24 hours, follow up in 2 to 5
          days, call after 6pm, international number. When your software has no brain, your
          calendar ends up living in your column names, and a qualified human ends up being
          the automation.
        </p>
        <p>
          The obvious answer in 2026 is AI, and the obvious risk is worse than the problem. An
          immigration firm is a regulated practice. A wrong promise in one email, a guarantee
          of a visa outcome, a fee quoted wrongly, advice given casually to someone whose case
          turns on the details: these are not typos. I did not want an AI that sends things.
          I wanted an AI that prepares things, and a structure that makes it physically unable
          to go further.
        </p>
        <p>
          So Barakah is built around one gate. Light, our intelligence, reads every enquiry,
          triages the junk with its reasons written down, drafts every reply from your
          firm&rsquo;s own knowledge, and queues the drafts for a human. The words you read
          are the words that send. The database refuses to send anything a named human has
          not approved. I hold the stamp in my own firm every morning, and I feel the
          difference between two hours of walking columns and a few minutes of reading drafts
          written properly, in our voice, with our fees and our boundaries respected.
        </p>
        <p>
          Everything lands on The Record, an append-only ledger of every act: what arrived,
          what Light did, what it cost, who approved what, and when. In a regulated
          profession the paper trail is not an afterthought of the work. It is the work. I
          wanted a system where the answer to &ldquo;why did this happen?&rdquo; is read, not
          remembered.
        </p>
        <p>
          Barakah is young and I will not pretend otherwise. There are no invented logos on
          this site, no testimonials we do not have, and no pricing table we would be making
          up. What there is: a working product, a pilot programme, and numbers from our own
          baseline that I am happy to show you against the live system. If you run an
          immigration practice and any of the above sounds like your Tuesday, I would
          genuinely like to talk.
        </p>
        <p>
          Mudassir
          <br />
          <span className="muted" style={{ fontSize: "0.95rem" }}>
            Founder, BarakahX
          </span>
        </p>
      </div>
      <div style={{ marginTop: "2.5rem" }}>
        <Link href={DEMO_PATH} className="btn btn-primary">
          Request a demo
        </Link>
      </div>
      </div>
    </section>
  );
}
