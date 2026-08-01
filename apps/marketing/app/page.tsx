import Link from "next/link";
import { RecordFragment } from "@/components/record-fragment";
import { ShotPlaceholder } from "@/components/shot-placeholder";
import { DEMO_PATH, SIGNUP_URL } from "@/lib/links";

/*
 * Home. Copy discipline (Session 17 fence): founder-note register, British
 * English, no em or en dashes anywhere, capability claims only, no invented
 * social proof. The before numbers are LEAD-LOG-BASELINE.md verbatim; the
 * after is what the product does, never a promised outcome.
 */

export default function HomePage() {
  return (
    <>
      {/* Hero */}
      <section className="section">
        <div
          className="container"
          style={{
            display: "grid",
            gap: "3rem",
            gridTemplateColumns: "repeat(auto-fit, minmax(20rem, 1fr))",
            alignItems: "center",
          }}
        >
          <div>
            <p className="eyebrow">For UK immigration firms</p>
            <h1 style={{ marginTop: "0.8rem" }}>
              Own the context.
              <br />
              Rent the intelligence.
            </h1>
            <div className="prose" style={{ marginTop: "1.4rem" }}>
              <p>
                Barakah is an operating system for immigration practices. Light, the
                intelligence that lives inside it, reads every enquiry, drafts every reply from
                your firm&rsquo;s own knowledge, and cannot send a single word until a human
                approves it.
              </p>
            </div>
            <div style={{ display: "flex", gap: "0.8rem", flexWrap: "wrap", marginTop: "1.8rem" }}>
              <Link href={DEMO_PATH} className="btn btn-primary">
                Request a demo
              </Link>
              <a href={SIGNUP_URL} className="btn btn-secondary">
                Set up your firm yourself
              </a>
            </div>
          </div>
          <RecordFragment />
        </div>
      </section>

      {/* The before, measured */}
      <section className="section rule-top" style={{ background: "var(--paper-deep)" }}>
        <div className="container">
          <p className="eyebrow">The problem, measured</p>
          <h2 style={{ marginTop: "0.8rem", maxWidth: "36rem" }}>
            We logged a week of lead follow-up by hand before writing a line of code.
          </h2>
          <div
            style={{
              display: "grid",
              gap: "3rem",
              gridTemplateColumns: "repeat(auto-fit, minmax(19rem, 1fr))",
              marginTop: "2rem",
            }}
          >
            <div className="prose">
              <p>
                Barakah was built inside a real UK immigration practice, our customer zero. We
                measured how enquiries were actually handled there before changing anything.
                Fifty Facebook leads arrived in eight days. Zero consultations were booked from
                them. A third were junk that a person still had to open, read and discard.
                Nobody recorded when a lead was last contacted, because the tracking columns sat
                empty on all fifty rows.
              </p>
              <p>
                And the principal spent about two hours every day walking follow-up columns
                whose only job was to remember time. Two hours of a qualified human simulating
                automation by hand.
              </p>
              <p>
                The pipeline had twelve stages, and four of them were not stages at all.
                &ldquo;24 hour follow up&rdquo;, &ldquo;2 to 5 days follow up&rdquo;,
                &ldquo;After 6 PM&rdquo;, &ldquo;International number&rdquo;. Timers wearing
                stage costumes, because when a tool has no brain the calendar has to live in
                the columns.
              </p>
            </div>
            <div>
              <dl
                style={{
                  margin: 0,
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "1.6rem 2rem",
                }}
              >
                {[
                  ["50", "leads in 8 days"],
                  ["0", "consultations booked"],
                  ["34%", "junk, still handled by hand"],
                  ["0 of 50", "had contact tracking filled in"],
                  ["~2 hours", "spent on triage, every day"],
                  ["4 of 12", "stages were really timers"],
                ].map(([num, label]) => (
                  <div key={label}>
                    <dt
                      style={{
                        fontFamily: "var(--font-serif)",
                        fontSize: "2rem",
                        fontWeight: 600,
                        lineHeight: 1.1,
                      }}
                    >
                      {num}
                    </dt>
                    <dd className="muted" style={{ margin: "0.2rem 0 0", fontSize: "0.9rem" }}>
                      {label}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="muted" style={{ fontSize: "0.8rem", marginTop: "1.6rem" }}>
                Source: our customer zero&rsquo;s own lead log, one measured week, July 2026.
                Real numbers, not a benchmark.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Timer costumes: the two pipelines side by side */}
      <section className="section rule-top">
        <div className="container">
          <p className="eyebrow">Timers are not stages</p>
          <h2 style={{ marginTop: "0.8rem", maxWidth: "34rem" }}>
            The old pipeline remembered time. The new one remembers meaning.
          </h2>
          <div
            style={{
              display: "grid",
              gap: "2.5rem",
              gridTemplateColumns: "repeat(auto-fit, minmax(18rem, 1fr))",
              marginTop: "2rem",
            }}
          >
            <div>
              <h3>Before: twelve columns, four of them clocks</h3>
              <ul className="stage-list" style={{ marginTop: "1rem" }}>
                <li>New</li>
                <li>
                  <span className="stage-costume">24 hour Follow up</span>
                  <span className="costume-note">a timer in costume</span>
                </li>
                <li>
                  <span className="stage-costume">2 to 5 Days Follow up</span>
                  <span className="costume-note">a timer in costume</span>
                </li>
                <li>
                  <span className="stage-costume">Follow up (After 6 PM)</span>
                  <span className="costume-note">a timer in costume</span>
                </li>
                <li>
                  <span className="stage-costume">International Number</span>
                  <span className="costume-note">a triage note in costume</span>
                </li>
                <li>Pending Qualification</li>
                <li>Qualified</li>
                <li>Meeting scheduled</li>
                <li>In negotiation</li>
                <li>Dead Lead</li>
                <li>Won</li>
                <li>Lost</li>
              </ul>
            </div>
            <div>
              <h3>After: stages that mean something</h3>
              <ul className="stage-list" style={{ marginTop: "1rem" }}>
                <li>New</li>
                <li>Contacted</li>
                <li>Qualified</li>
                <li>Consultation booked</li>
                <li>Consultation held</li>
                <li>Instructed</li>
                <li>Won · Lost · Unresponsive · Disqualified</li>
              </ul>
              <p className="prose muted" style={{ marginTop: "1.2rem", fontSize: "0.92rem" }}>
                In Barakah, timers are workflow data. Follow-ups fire on their own clock,
                respect quiet hours, and land as drafts for your approval. Junk and
                international-number handling become triage with a stated reason on The
                Record, not parking columns a human has to walk.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* The stamp loop */}
      <section className="section rule-top" style={{ background: "var(--paper-deep)" }}>
        <div className="container">
          <p className="eyebrow">The stamp loop</p>
          <h2 style={{ marginTop: "0.8rem", maxWidth: "32rem" }}>
            Light does the walking. You keep the signature.
          </h2>
          <div
            style={{
              display: "grid",
              gap: "3rem",
              gridTemplateColumns: "repeat(auto-fit, minmax(19rem, 1fr))",
              marginTop: "2rem",
              alignItems: "center",
            }}
          >
            <div className="prose">
              <p>
                A new enquiry lands. Light reads it, checks it against your firm&rsquo;s
                published services and fees, and drafts a reply within minutes, on the channel
                the enquirer actually uses. Junk is triaged out with a stated reason you can
                audit later.
              </p>
              <p>
                What reaches you is a queue of drafts in the Approval Inbox. You read the exact
                words. You approve, or you reject with a reason. That is the whole job now:
                minutes of stamping instead of hours of walking columns.
              </p>
              <p>
                <strong>Nothing sends without your approval. Not as a policy, as physics:</strong>{" "}
                the database that carries your messages refuses outbound communication that no
                human has stamped.
              </p>
            </div>
            <ShotPlaceholder label="The Approval Inbox: a Light draft awaiting the stamp" width={1600} height={1000} />
          </div>
        </div>
      </section>

      {/* Trust pillars */}
      <section className="section rule-top">
        <div className="container">
          <p className="eyebrow">Built for a regulated profession</p>
          <h2 style={{ marginTop: "0.8rem", maxWidth: "34rem" }}>
            Three promises, kept structurally.
          </h2>
          <div
            style={{
              display: "grid",
              gap: "2.5rem",
              gridTemplateColumns: "repeat(auto-fit, minmax(17rem, 1fr))",
              marginTop: "2.2rem",
            }}
          >
            <div>
              <h3>The approval gate</h3>
              <p className="muted" style={{ marginTop: "0.7rem", fontSize: "0.95rem" }}>
                Every outbound message carries the name of the human who approved it. There is
                no bulk approve, and there never will be. Refusal is enforced in the database,
                not requested in a prompt.
              </p>
            </div>
            <div>
              <h3>The Record</h3>
              <p className="muted" style={{ marginTop: "0.7rem", fontSize: "0.95rem" }}>
                Every act lands on an append-only ledger: who did what, when, on whose
                approval, and what the intelligence spent doing it. &ldquo;Why did Light say
                that?&rdquo; is always answerable, forever.
              </p>
            </div>
            <div>
              <h3>What you see is what sends</h3>
              <p className="muted" style={{ marginTop: "0.7rem", fontSize: "0.95rem" }}>
                The words on the card at stamp time are the exact words the enquirer receives,
                on the exact channel they will receive them. Your stamp never approves words a
                client will not see.
              </p>
            </div>
          </div>
          <p className="muted" style={{ marginTop: "2.2rem", fontSize: "0.9rem", maxWidth: "40rem" }}>
            <Link href="/product">Read how the gate, the ledger and the drafting work</Link>, in
            plain language.
          </p>
        </div>
      </section>

      {/* Doctrine */}
      <section className="section rule-top" style={{ background: "var(--ink)", color: "var(--paper)" }}>
        <div className="container" style={{ maxWidth: "46rem" }}>
          <p className="eyebrow" style={{ color: "#a49c8c" }}>
            From our operating doctrine
          </p>
          <blockquote
            style={{
              margin: "1.2rem 0 0",
              fontFamily: "var(--font-serif)",
              fontSize: "clamp(1.3rem, 2.6vw, 1.7rem)",
              lineHeight: 1.45,
            }}
          >
            &ldquo;Light spends the minimum intelligence that produces a correct, safe act.
            And every unit it spends is a metered line on The Record.&rdquo;
          </blockquote>
          <p style={{ marginTop: "1.4rem", color: "#c9c2b4", fontSize: "0.95rem", maxWidth: "38rem" }}>
            Your firm&rsquo;s context stays yours: your knowledge, your history, your client
            relationships. The intelligence is rented by the act, priced on the ledger, and the
            rent is visibly fair. That is the whole idea in one line: own the context, rent the
            intelligence.
          </p>
        </div>
      </section>

      {/* CTA band */}
      <section className="section">
        <div className="container" style={{ textAlign: "center" }}>
          <h2 style={{ maxWidth: "30rem", marginInline: "auto" }}>
            See your own pipeline run this way.
          </h2>
          <p className="muted" style={{ marginTop: "1rem", maxWidth: "34rem", marginInline: "auto" }}>
            A demo is a working session, not a slideshow: your enquiry flow, the stamp loop,
            and The Record, live.
          </p>
          <div
            style={{
              display: "flex",
              gap: "0.8rem",
              justifyContent: "center",
              flexWrap: "wrap",
              marginTop: "1.8rem",
            }}
          >
            <Link href={DEMO_PATH} className="btn btn-primary">
              Request a demo
            </Link>
            <a href={SIGNUP_URL} className="btn btn-secondary">
              Sign up directly
            </a>
          </div>
        </div>
      </section>
    </>
  );
}
