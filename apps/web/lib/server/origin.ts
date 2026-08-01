import "server-only";

import { canonicalOrigin } from "@/lib/app-url";

/**
 * Origin as the outside world should address us. The canonical seam
 * (Session 18): NEXT_PUBLIC_APP_URL wins when set. Otherwise the origin is
 * derived per-request — on Vercel the proxy rewrites request.url, so
 * redirects built from it would point at the internal host;
 * x-forwarded-host carries the real one. Request derivation is what lets
 * localhost and previews share this code with nothing configured.
 */
export function externalOrigin(request: Request): string {
  const url = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host");
  let derived: string;
  if (process.env.NODE_ENV === "development" || !forwardedHost) {
    derived = url.origin;
  } else {
    const proto = request.headers.get("x-forwarded-proto") ?? "https";
    derived = `${proto}://${forwardedHost}`;
  }
  return canonicalOrigin(derived);
}
