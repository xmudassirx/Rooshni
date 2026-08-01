import type { Metadata } from "next";
import Link from "next/link";
import { DEMO_PATH, SIGNUP_URL } from "@/lib/links";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Barakah is in its pilot era. Pilot pricing on request; every pilot firm gets the whole product.",
};

/*
 * Pricing fence (Session 17): placeholder tiers marked "pilot pricing on
 * request", NO invented numbers anywhere.
 */

export default function PricingPage() {
  return (
    <>
      <section className="section">
        <div className="container">
          <p className="eyebrow">Pricing</p>
          <h1 style={{ marginTop: "0.8rem", maxWidth: "36rem", fontSize: "clamp(2.1rem, 5vw, 3.2rem)" }}>
            Pilot era. Plain terms.
          </h1>
          <p className="prose" style={{ marginTop: "1.4rem" }}>
            Barakah is running with early pilot firms. Pilots pay, because a product you do
            not pay for is a product nobody is accountable to you for. There is no free tier
            and no trial wall that disappears later. Pilot pricing is agreed in conversation,
            not listed here, because it depends on your enquiry volume and channels.
          </p>
        </div>
      </section>

      <section className="section rule-top" style={{ background: "var(--paper-deep)" }}>
        <div className="container">
          <div
            style={{
              display: "grid",
              gap: "1.5rem",
              gridTemplateColumns: "repeat(auto-fit, minmax(17rem, 1fr))",
              maxWidth: "56rem",
            }}
          >
            <div
              style={{
                background: "#fffefb",
                border: "1px solid var(--rule)",
                borderRadius: "0.375rem",
                padding: "2rem",
              }}
            >
              <p className="eyebrow">Pilot · Firm</p>
              <p
                style={{
                  fontFamily: "var(--font-serif)",
                  fontSize: "1.6rem",
                  fontWeight: 600,
                  marginTop: "0.8rem",
                }}
              >
                Pilot pricing on request
              </p>
              <ul style={{ margin: "1.2rem 0 0", paddingLeft: "1.1rem", fontSize: "0.95rem", display: "grid", gap: "0.5rem" }}>
                <li>The whole product: pipeline, drafting, Approval Inbox, The Record</li>
                <li>Email and WhatsApp, connected as your firm</li>
                <li>Meta lead forms straight into the pipeline</li>
                <li>Your knowledge pack, your no-go rules, your quiet hours</li>
                <li>Metered intelligence, every act priced on the ledger</li>
                <li>Set-up alongside us, on your real enquiries</li>
              </ul>
              <div style={{ marginTop: "1.8rem", display: "flex", gap: "0.8rem", flexWrap: "wrap" }}>
                <Link href={DEMO_PATH} className="btn btn-primary">
                  Request a demo
                </Link>
                <a href={SIGNUP_URL} className="btn btn-secondary">
                  Sign up directly
                </a>
              </div>
            </div>
            <div style={{ alignSelf: "center", maxWidth: "24rem" }}>
              <h3>Why no price list yet?</h3>
              <p className="muted" style={{ marginTop: "0.7rem", fontSize: "0.95rem" }}>
                Because we would be inventing it. Public tiers arrive when enough pilots have
                run for the numbers to be honest. Until then, one conversation settles it, and
                what we agree is what you pay.
              </p>
              <h3 style={{ marginTop: "1.6rem" }}>What a pilot involves</h3>
              <p className="muted" style={{ marginTop: "0.7rem", fontSize: "0.95rem" }}>
                Your live enquiry channels connected, your knowledge pack loaded, and the
                stamp loop in your hands within days. You see every act on The Record from day
                one, including what the intelligence costs.
              </p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
