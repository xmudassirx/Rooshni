import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms",
  description: "Pilot-era terms for the Barakah website and pilot programme.",
};

/*
 * Honestly marked pilot-era stub (Session 17 fence). No invented legal
 * boilerplate; it says what is true of the pilot arrangement today.
 */

export default function TermsPage() {
  return (
    <section className="section">
      <div className="container prose" style={{ maxWidth: "44rem" }}>
        <p className="eyebrow">Terms</p>
        <h1 style={{ marginTop: "0.8rem", fontSize: "clamp(1.9rem, 4vw, 2.6rem)" }}>
          Terms of use
        </h1>
        <p className="muted" style={{ marginTop: "0.8rem", fontSize: "0.9rem" }}>
          A pilot-era document, deliberately short. Full terms of service, reviewed by
          counsel, will replace it before general availability.
        </p>
        <div style={{ marginTop: "2rem", display: "grid", gap: "1.6rem" }}>
          <div>
            <h3>This website</h3>
            <p style={{ marginTop: "0.5rem" }}>
              The content on this site describes Barakah as it exists during its pilot
              programme. We keep claims factual and current, and we correct anything we find
              to be wrong. Nothing on this site is legal advice, immigration advice, or an
              offer capable of acceptance; it is information about a product.
            </p>
          </div>
          <div>
            <h3>The pilot programme</h3>
            <p style={{ marginTop: "0.5rem" }}>
              Barakah is currently offered to firms under individual pilot arrangements. The
              terms that govern actual use of the product, including fees, data processing,
              service levels and liability, are agreed in writing with each pilot firm before
              their use begins. Creating an account is the start of that conversation, not a
              contract for the finished service.
            </p>
          </div>
          <div>
            <h3>Your responsibilities as a regulated firm</h3>
            <p style={{ marginTop: "0.5rem" }}>
              Barakah prepares drafts and keeps records; it does not give immigration advice
              and it does not remove your professional obligations. Every message the system
              sends carries a named human approval from your firm, and responsibility for
              approved communications remains with the approving firm.
            </p>
          </div>
          <div>
            <h3>Questions</h3>
            <p style={{ marginTop: "0.5rem" }}>
              Ask us anything about these terms through the demo request form and a human
              will answer. Last updated 1 August 2026.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
