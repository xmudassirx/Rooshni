/**
 * The two destinations every call to action resolves to (Session 17 scope):
 * /demo is the primary; the product signup is the secondary, for firms ready
 * to self serve.
 *
 * Product URLs follow the Session 18 canonical-URL seam by VALUE: the same
 * NEXT_PUBLIC_APP_URL the product app reads (apps/web/lib/app-url.ts), set
 * in the marketing Vercel project too — never a hardcoded production host.
 * JUDGMENT: the marketing app cannot derive the product's origin from its
 * own requests (different site), so where apps/web falls back to the
 * request-derived origin, this helper's only fallback is the local dev
 * server; production/preview must set NEXT_PUBLIC_APP_URL (GO-LIVE lists it
 * among the marketing project's env vars).
 */
export const DEMO_PATH = "/demo";

function productOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (configured && configured.trim() !== "") {
    return configured.trim().replace(/\/+$/, "");
  }
  return "http://localhost:3000";
}

export const SIGNUP_URL = `${productOrigin()}/signup`;

export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3100";
