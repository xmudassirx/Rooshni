import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy",
  description: "How this site handles your data during Barakah's pilot era.",
};

/*
 * Honestly marked pilot-era stub (Session 17 fence). It states exactly what
 * the site does today: one form, no analytics, no cookies, no trackers.
 */

export default function PrivacyPage() {
  return (
    <section className="section">
      <div className="container prose" style={{ maxWidth: "44rem" }}>
        <p className="eyebrow">Privacy</p>
        <h1 style={{ marginTop: "0.8rem", fontSize: "clamp(1.9rem, 4vw, 2.6rem)" }}>
          Privacy notice
        </h1>
        <p className="muted" style={{ marginTop: "0.8rem", fontSize: "0.9rem" }}>
          A pilot-era document, deliberately short. It describes what this site actually does
          today. A full policy, reviewed by counsel, will replace it before general
          availability. If anything here is unclear, ask us directly through the demo form.
        </p>
        <div style={{ marginTop: "2rem", display: "grid", gap: "1.6rem" }}>
          <div>
            <h3>What this site collects</h3>
            <p style={{ marginTop: "0.5rem" }}>
              One thing: what you type into the demo request form. That is your name, your
              firm&rsquo;s name, your work email, optionally a phone number, and anything you
              choose to tell us about your enquiry handling. Nothing is collected from you by
              simply browsing.
            </p>
          </div>
          <div>
            <h3>What this site does not do</h3>
            <p style={{ marginTop: "0.5rem" }}>
              No analytics scripts. No advertising pixels. No third-party trackers. No
              cookies set by us for browsing this site, which is why you have not been asked
              to accept any.
            </p>
          </div>
          <div>
            <h3>What happens to a demo request</h3>
            <p style={{ marginTop: "0.5rem" }}>
              It is stored as an enquiry in our own Barakah system, the same product this site
              describes, and handled by a human. We use it to reply to you and for nothing
              else. We do not sell it, share it, or add you to a mailing list you did not ask
              for.
            </p>
          </div>
          <div>
            <h3>Removal</h3>
            <p style={{ marginTop: "0.5rem" }}>
              Ask, and we delete your request and its contact details. The fastest route is
              replying to the email we send you, or submitting the demo form with your
              request.
            </p>
          </div>
          <div>
            <h3>Who we are</h3>
            <p style={{ marginTop: "0.5rem" }}>
              BarakahX, the company behind Barakah, operating from the United Kingdom. This
              notice was last updated on 1 August 2026.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
