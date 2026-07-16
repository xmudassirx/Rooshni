import type { Metadata } from "next";
import Link from "next/link";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Barakah — payment received",
  description: "Your account is being prepared.",
};

/**
 * Stripe Checkout's success landing. Activation happens on the webhook (the
 * only door — decision 80), usually within seconds of arriving here; the way
 * into the shell is the existing Google sign-in against the allowlist row
 * activation creates (founder ruling, 17 July 2026).
 */
export default function SignupSuccessPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className="w-full max-w-[520px] text-center">
        <div className="mb-5">
          <div className="font-display text-[22px] font-extrabold tracking-tight text-ink">Barakah</div>
          <div className="mt-0.5 font-mono text-[9.5px] uppercase tracking-[0.18em] text-ink-faint">
            payment received
          </div>
        </div>
        <div className="glass rounded-xl px-6 py-8">
          <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ledger">
            ✓ Payment cleared
          </div>
          <h1 className="font-display text-[19px] font-extrabold text-ink">
            Your firm&apos;s account is being prepared
          </h1>
          <p className="mx-auto mt-2 max-w-[46ch] text-[13.5px] leading-relaxed text-ink-soft">
            It takes a few seconds. Sign in with Google using the email you gave at signup — your
            first week&apos;s setup is waiting for you inside, under <b>First Light</b>.
          </p>
          <div className="mt-5">
            <Link
              href="/signin"
              className="inline-flex items-center justify-center rounded-lg bg-accent px-5 py-2.5 text-[13px] font-semibold text-white shadow-panel"
            >
              Sign in with Google
            </Link>
          </div>
        </div>
        <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.05em] text-ink-faint">
          Every act on your account is on The Record — starting with this payment.
        </p>
      </div>
    </div>
  );
}
