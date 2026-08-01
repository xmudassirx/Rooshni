/**
 * The canonical app-URL seam (Session 18, founder-approved). Every absolute
 * URL the product composes routes through this ONE helper: the
 * NEXT_PUBLIC_APP_URL env var wins when set (production, where it carries
 * the custom domain), and the caller's request-derived origin is the
 * fallback otherwise — so localhost and Vercel previews keep working with
 * nothing configured, and click-review is never broken by the seam.
 *
 * Deliberately isomorphic (no "server-only"): server code passes an origin
 * derived from the request, the sign-in button passes
 * window.location.origin. No production code path may compose an absolute
 * URL from VERCEL_URL or a hardcoded host.
 */
export function canonicalOrigin(requestDerivedOrigin: string): string {
  // Referenced literally so Next.js inlines the value into client bundles.
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (!configured || configured.trim() === "") {
    return requestDerivedOrigin;
  }
  // Normalise: no trailing slash, so `${origin}/path` composition is safe.
  return configured.trim().replace(/\/+$/, "");
}
