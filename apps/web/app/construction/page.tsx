import type { Metadata } from "next";
import Link from "next/link";

/**
 * The public holding page (Session 5). Everyone who is not signed in AND
 * allowlisted lands here — the middleware rewrites every app URL to this
 * page, so to the outside world the deployment is a quiet site being built.
 * The only way past it is the discreet sign-in below.
 *
 * Founder rule (Session 5 sign-off): this page carries no product name and
 * no hint of what sits behind it. The metadata below overrides the root
 * layout's, which would otherwise leak the name into the tab title.
 */

export const metadata: Metadata = {
  title: "Under construction",
  description: "This site is under construction.",
};

export default function ConstructionPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-paper px-6 text-center">
      <div className="h-px w-24 bg-rule" />
      <p className="mt-8 max-w-[40ch] text-[15px] leading-relaxed text-ink-soft">
        Something is being built here. Please check back soon.
      </p>
      <Link
        href="/signin"
        className="mt-14 font-mono text-[10.5px] tracking-wide text-ink-faint uppercase transition-colors hover:text-ink"
      >
        Sign in
      </Link>
    </div>
  );
}
