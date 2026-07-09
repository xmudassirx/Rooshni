import Link from "next/link";

/**
 * The public holding page (Session 5). Everyone who is not signed in AND
 * allowlisted lands here — the middleware rewrites every app URL to this
 * page, so to the outside world the deployment is a quiet site being built.
 * The only way past it is the discreet sign-in below.
 */
export default function ConstructionPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-paper px-6 text-center">
      <div className="font-display text-3xl font-black tracking-tight text-ink">
        Rooshni
      </div>
      <div className="mt-1.5 font-mono text-[10px] tracking-[.18em] text-ink-faint uppercase">
        One database · many faces
      </div>
      <div className="mt-8 h-px w-24 bg-rule" />
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
