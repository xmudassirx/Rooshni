"use client";

import { useState } from "react";

/**
 * The two-step signup pair (decision 79, mockup Pass 4 v2). Step 1 collects
 * the five details — the email field states the Google constraint up front
 * (founder ruling: at step 1, not after payment). Step 2 is the plan card
 * and the Stripe button. No template picker: UK Immigration Advisory v3
 * applies by default.
 */

export interface ResumedSignup {
  accountId: string;
  resumeToken: string;
  email: string;
  businessName: string;
}

interface FieldProps {
  label: string;
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  type?: string;
  autoComplete?: string;
  note?: React.ReactNode;
}

function Field({ label, id, value, onChange, placeholder, type = "text", autoComplete, note }: FieldProps) {
  return (
    <div className="mb-3">
      <label
        htmlFor={id}
        className="mb-1 block font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint"
      >
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        autoComplete={autoComplete}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-[9px] border-[1.5px] border-rule bg-paper px-3.5 py-2.5 text-[14.5px] text-ink outline-none transition-colors focus:border-accent"
      />
      {note ? <small className="mt-1 block text-[11.5px] text-ink-soft">{note}</small> : null}
    </div>
  );
}

function StepRail({ step }: { step: 1 | 2 }) {
  return (
    <div className="mx-auto mb-4 flex max-w-[340px]">
      <span
        className={`flex-1 border-b-2 pb-2 text-center font-mono text-[9.5px] uppercase tracking-[0.1em] ${
          step === 1 ? "border-accent font-semibold text-accent" : "border-ledger text-ledger"
        }`}
      >
        1 · Your details{step === 2 ? " ✓" : ""}
      </span>
      <span
        className={`flex-1 border-b-2 pb-2 text-center font-mono text-[9.5px] uppercase tracking-[0.1em] ${
          step === 2 ? "border-accent font-semibold text-accent" : "border-rule text-ink-faint"
        }`}
      >
        2 · Plan &amp; payment
      </span>
    </div>
  );
}

function Brand({ sub }: { sub: string }) {
  return (
    <div className="mb-5 text-center">
      <div className="font-display text-[22px] font-extrabold tracking-tight text-ink">Barakah</div>
      <div className="mt-0.5 font-mono text-[9.5px] uppercase tracking-[0.18em] text-ink-faint">{sub}</div>
    </div>
  );
}

export function SignupWizard({ resumed }: { resumed: ResumedSignup | null }) {
  const [step, setStep] = useState<1 | 2>(resumed ? 2 : 1);
  const [name, setName] = useState("");
  const [businessName, setBusinessName] = useState(resumed?.businessName ?? "");
  const [email, setEmail] = useState(resumed?.email ?? "");
  const [phone, setPhone] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [signup, setSignup] = useState<{ accountId: string; resumeToken: string } | null>(
    resumed ? { accountId: resumed.accountId, resumeToken: resumed.resumeToken } : null
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function continueToPlan() {
    setError(null);
    if (!businessName.trim()) {
      setError("Business name is the one field that can't wait.");
      return;
    }
    if (!name.trim() || !email.includes("@")) {
      setError("Your name and a working email are needed to hold your place.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, businessName, email, phone, websiteUrl }),
      });
      const body = (await response.json()) as {
        accountId?: string;
        resumeToken?: string;
        error?: string;
      };
      if (!response.ok || !body.accountId || !body.resumeToken) {
        throw new Error(body.error ?? "Something went wrong holding your details.");
      }
      setSignup({ accountId: body.accountId, resumeToken: body.resumeToken });
      setStep(2);
      window.scrollTo({ top: 0 });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function payWithStripe() {
    if (!signup) return;
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/signup/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signup),
      });
      const body = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || !body.url) {
        throw new Error(body.error ?? "Could not open the payment page.");
      }
      window.location.assign(body.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open the payment page.");
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className="w-full max-w-[520px]">
        {step === 1 ? (
          <>
            <Brand sub="own the context, rent the intelligence" />
            <StepRail step={1} />
            <div className="glass overflow-hidden rounded-xl">
              <div className="px-5 pb-6 pt-5">
                <Field label="Your name" id="su-name" value={name} onChange={setName} placeholder="Full name" autoComplete="name" />
                <Field label="Business name" id="su-biz" value={businessName} onChange={setBusinessName} placeholder="e.g. Acme & Co" autoComplete="organization" />
                <Field
                  label="Email"
                  id="su-email"
                  type="email"
                  value={email}
                  onChange={setEmail}
                  placeholder="you@yourcompany.com"
                  autoComplete="email"
                  note="Use an email you can sign in to Google with — it becomes your sign-in."
                />
                <Field label="Phone" id="su-phone" type="tel" value={phone} onChange={setPhone} placeholder="+44…" autoComplete="tel" />
                <Field
                  label="Your website"
                  id="su-site"
                  value={websiteUrl}
                  onChange={setWebsiteUrl}
                  placeholder="yourcompany.com"
                  note={
                    <>
                      <span className="light-spark">✦</span> The moment your payment clears, Light
                      reads your website and starts setting up for you — before you&apos;ve finished
                      your first cup of tea.
                    </>
                  }
                />
                {error ? <p className="mb-2 text-[12.5px] text-stamp">{error}</p> : null}
                <button
                  onClick={continueToPlan}
                  disabled={busy}
                  className="mt-1.5 w-full rounded-lg bg-accent px-3.5 py-[11px] text-[13px] font-semibold text-white shadow-panel transition-transform active:scale-[0.98] disabled:opacity-60"
                >
                  {busy ? "Holding your details…" : "Continue → Plan & payment"}
                </button>
              </div>
            </div>
            <p className="mt-3 text-center font-mono text-[11px] uppercase tracking-[0.05em] text-ink-faint">
              UK Immigration Advisory · v3 applies — Barakah is built for immigration firms first.
              Vertical settings live in Settings → General.
            </p>
          </>
        ) : (
          <>
            <Brand sub="pilot plan · billed monthly · cancel any time" />
            <StepRail step={2} />
            <div className="glass overflow-hidden rounded-xl">
              <div className="px-5 pb-6 pt-5">
                <div className="mb-3.5 rounded-[14px] border-[1.5px] border-accent bg-accent-tint px-4 py-4">
                  <div className="text-[16px] font-extrabold text-ink">Pilot · Firm</div>
                  <div className="mb-2 mt-0.5 font-mono text-[20px] font-semibold text-ink">
                    £149<span className="text-[11px] text-ink-soft"> /month + credits as used</span>
                  </div>
                  <ul className="flex flex-col gap-1 text-[13px] text-ink">
                    <li><span className="text-accent">— </span>1 business · 3 seats · Light Standard included, Pro metered</li>
                    <li><span className="text-accent">— </span>Every AI act gated, priced and on The Record</li>
                    <li><span className="text-accent">— </span>Founder walkthrough included — a person, not a video</li>
                  </ul>
                </div>
                <div className="px-0.5">
                  <div className="flex justify-between gap-2.5 border-b border-rule px-0.5 py-2 text-[12.5px]">
                    <b className="font-bold text-ink">Soft cap — warn</b>
                    <span className="text-right text-ink-soft">£45 · dashboard vigilance item when crossed</span>
                  </div>
                  <div className="flex justify-between gap-2.5 border-b border-rule px-0.5 py-2 text-[12.5px]">
                    <b className="font-bold text-ink">Hard cap — stop</b>
                    <span className="text-right text-ink-soft">£60 · Light halts, queues work, tells you why</span>
                  </div>
                  <div className="flex justify-between gap-2.5 px-0.5 py-2 text-[12.5px]">
                    <b className="font-bold text-ink">Per-action gate</b>
                    <span className="text-right text-ink-soft">ask first above £3 · &ldquo;this costs ~£4 — proceed?&rdquo;</span>
                  </div>
                </div>
                {error ? <p className="mt-3 text-[12.5px] text-stamp">{error}</p> : null}
                <button
                  onClick={payWithStripe}
                  disabled={busy}
                  className="mt-3.5 flex w-full items-center justify-center gap-2 rounded-[10px] bg-[#635BFF] px-3 py-3 text-[14.5px] font-bold text-white shadow-panel transition-transform active:scale-[0.99] disabled:opacity-60"
                >
                  {busy ? "Opening Stripe…" : (
                    <>Pay with <b className="font-display">stripe</b> · £149</>
                  )}
                </button>
                <p className="mt-2.5 text-center font-mono text-[11px] uppercase tracking-[0.05em] text-ink-faint">
                  Payment handled securely by Stripe · cancel any time. Light begins setting up
                  your business the moment payment clears.
                </p>
              </div>
            </div>
            {!resumed ? (
              <div className="mt-2.5 text-center">
                <button
                  onClick={() => setStep(1)}
                  className="glass rounded-lg px-3 py-1.5 text-[12px] font-semibold text-ink"
                >
                  ← Back to details
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
