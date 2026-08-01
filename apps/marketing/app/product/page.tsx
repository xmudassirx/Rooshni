import type { Metadata } from "next";
import Link from "next/link";
import { ShotPlaceholder } from "@/components/shot-placeholder";
import { DEMO_PATH, SIGNUP_URL } from "@/lib/links";

export const metadata: Metadata = {
  title: "Product",
  description:
    "How Barakah works: the approval gate, The Record, and drafting from your firm's own knowledge. Built for UK immigration practices.",
};

/*
 * The product story in the founder-note register: the gate, the ledger, the
 * drafting. Capability claims only; every claim here is enforced in the
 * product's database, not aspirational.
 */

function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="section rule-top">
      <div className="container">
        <p className="eyebrow">{eyebrow}</p>
        <h2 style={{ marginTop: "0.8rem", maxWidth: "34rem" }}>{title}</h2>
        {children}
      </div>
    </section>
  );
}

export default function ProductPage() {
  return (
    <>
      <section className="section">
        <div className="container">
          <p className="eyebrow">Product</p>
          <h1 style={{ marginTop: "0.8rem", maxWidth: "38rem", fontSize: "clamp(2.1rem, 5vw, 3.2rem)" }}>
            The gate, the ledger, and the drafting.
          </h1>
          <p className="prose" style={{ marginTop: "1.4rem" }}>
            Barakah runs your enquiry pipeline end to end: capture, triage, drafting,
            follow-up, and the paper trail. This page explains the three structures everything
            else stands on, in plain language.
          </p>
        </div>
      </section>

      <Section eyebrow="Structure one" title="The approval gate: no stamp, no send.">
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
              Every outbound message in Barakah, email or WhatsApp, must carry the identity of
              the human who approved it before the system will send it. This is not an app
              setting or a model instruction. The database that stores your communications
              physically refuses to mark a message approved or sent without a named human
              stamp. Light cannot hold the stamp. Our own engineers cannot quietly bypass it
              from application code, because the refusal lives below the application.
            </p>
            <p>
              Approvals are individual, always. You can reject drafts in bulk, with a reason
              recorded on each. You cannot approve in bulk, and no future version will let
              you. A signature you did not individually give is not a signature.
            </p>
            <p>
              Before a draft can even reach your stamp it passes a readiness check: no missing
              content, no unresolved placeholders, consent on file for the channel it will
              travel on. Approving a broken message is impossible, not discouraged.
            </p>
          </div>
          <ShotPlaceholder label="An Approval Inbox card: the draft, its context, and the stamp" width={1600} height={1000} />
        </div>
      </Section>

      <Section eyebrow="Structure two" title="The Record: every act, on an append-only ledger.">
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
              Everything that happens in Barakah lands as a line on The Record: an enquiry
              arriving, Light drafting, a compliance check passing, your approval, the send,
              the stage move that followed. Lines are never edited and never deleted. The
              history your regulator, your client, or your own memory might one day need is
              not reconstructable, it is already written.
            </p>
            <p>
              The ledger also meters the intelligence. Every act Light performs records which
              model tier it used, why that tier, and what it cost. When you ask why Light said
              something, or why it cost what it did, the answer is read off The Record, not
              recalled from anyone&rsquo;s memory.
            </p>
          </div>
          <ShotPlaceholder label="The Record: a day of enquiry activity, gold for Light, red for stamps" width={1600} height={1000} />
        </div>
      </Section>

      <Section eyebrow="Structure three" title="Drafting from your context, inside your rules.">
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
              Light drafts from your firm&rsquo;s own knowledge pack: your service
              descriptions per visa route, your published fees, your booking policy, your
              tone. It answers what the enquirer actually asked, in your voice, and invites a
              consultation where the answer genuinely needs one.
            </p>
            <p>
              It drafts inside no-go rules made for immigration work, checked at generation
              and again before the stamp. Light never states or implies a guarantee of visa
              success or Home Office timescales. It never gives case-specific legal advice in
              an unstamped channel; generalities and process are fine, advice happens in
              consultations with your humans. It never quotes fees beyond what you have
              published. A draft that breaches a rule is blocked and says which rule, in red,
              before it ever reaches your queue.
            </p>
            <p>
              And what you see is what sends. Drafts are per-channel from birth: the words on
              the card at stamp time are the exact words the enquirer receives on that
              channel. An edit re-checks the edited words. Your stamp never approves a
              different sentence than the one you read.
            </p>
          </div>
          <ShotPlaceholder label="A draft with its context: the enquirer's answers, the pack entries used, the compliance check" width={1600} height={1000} />
        </div>
      </Section>

      <Section eyebrow="Around the structures" title="The pipeline that runs on top.">
        <div
          style={{
            display: "grid",
            gap: "2.5rem",
            gridTemplateColumns: "repeat(auto-fit, minmax(17rem, 1fr))",
            marginTop: "2.2rem",
          }}
        >
          <div>
            <h3>Timers are data, not stages</h3>
            <p className="muted" style={{ marginTop: "0.7rem", fontSize: "0.95rem" }}>
              Follow-ups at one, two and four business days run as workflow timers, not as
              pipeline columns a human walks. Stamped messages that would land in the evening
              queue politely and dispatch in the morning: the stamp is yours, the timing is
              policy.
            </p>
          </div>
          <div>
            <h3>Honest silence</h3>
            <p className="muted" style={{ marginTop: "0.7rem", fontSize: "0.95rem" }}>
              An enquiry closes as unresponsive only when follow-ups genuinely reached the
              enquirer. If nudges were never approved or never delivered, Barakah refuses to
              blame the client for our silence, states why on The Record, and leaves the
              enquiry open for a human.
            </p>
          </div>
          <div>
            <h3>Conversations that keep up</h3>
            <p className="muted" style={{ marginTop: "0.7rem", fontSize: "0.95rem" }}>
              Replies arrive live, WhatsApp and email in one thread. If an enquirer writes
              again while a draft is still waiting for your stamp, Light retires that draft on
              the record and drafts fresh against the whole conversation. Your own reply
              always wins: send one and the pending draft steps aside, with the reason
              logged.
            </p>
          </div>
          <div>
            <h3>Junk handled, visibly</h3>
            <p className="muted" style={{ marginTop: "0.7rem", fontSize: "0.95rem" }}>
              A third of paid leads in our baseline were junk a person still had to touch.
              Light triages junk out with a stated reason on The Record, so your time goes to
              enquirers, and the discard trail survives audit.
            </p>
          </div>
          <div>
            <h3>Immigration first</h3>
            <p className="muted" style={{ marginTop: "0.7rem", fontSize: "0.95rem" }}>
              The vocabulary, the pipeline stages, the no-go rules and the knowledge
              categories ship tuned for UK immigration advice, from IAA level considerations
              to visa-route service descriptions. The platform beneath is general by design;
              the vertical focus is deliberate.
            </p>
          </div>
          <div>
            <h3>One database, many faces</h3>
            <p className="muted" style={{ marginTop: "0.7rem", fontSize: "0.95rem" }}>
              Pipeline, conversations, tasks, approvals and The Record are views over the
              same store. A stage move stamped once is reflected everywhere at once. There is
              no syncing, because there is nothing to sync.
            </p>
          </div>
        </div>
      </Section>

      <section className="section rule-top">
        <div className="container" style={{ textAlign: "center" }}>
          <h2 style={{ maxWidth: "30rem", marginInline: "auto" }}>
            Watch the gate hold, live.
          </h2>
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
