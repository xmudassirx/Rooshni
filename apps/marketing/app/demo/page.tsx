import type { Metadata } from "next";
import { DemoForm } from "./demo-form";

export const metadata: Metadata = {
  title: "Request a demo",
  description:
    "Request a working demo of Barakah: your enquiry flow, the stamp loop, and The Record, live. A human replies.",
};

export default function DemoPage() {
  return (
    <section className="section">
      <div
        className="container"
        style={{
          display: "grid",
          gap: "3.5rem",
          gridTemplateColumns: "repeat(auto-fit, minmax(19rem, 1fr))",
          maxWidth: "58rem",
        }}
      >
        <div>
          <p className="eyebrow">Request a demo</p>
          <h1 style={{ marginTop: "0.8rem", fontSize: "clamp(2rem, 4.5vw, 2.8rem)" }}>
            A working session, not a slideshow.
          </h1>
          <div className="prose" style={{ marginTop: "1.4rem" }}>
            <p>
              Tell us a little about your practice and we will show you Barakah running a real
              enquiry flow: capture, triage, Light&rsquo;s draft, your stamp, and the whole
              story on The Record.
            </p>
            <p>
              Your request goes straight into our own Barakah pipeline, the same product this
              site describes, and a human replies. No mailing list, no automated sales
              sequence.
            </p>
          </div>
        </div>
        <DemoForm />
      </div>
    </section>
  );
}
