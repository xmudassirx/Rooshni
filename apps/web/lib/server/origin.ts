import "server-only";

/**
 * Origin as the outside world saw it. On Vercel the proxy rewrites
 * request.url, so redirects built from it would point at the internal host;
 * x-forwarded-host carries the real one. Deriving it per-request (rather
 * than from an env var) is what lets localhost, previews, production and a
 * future custom domain share this code unchanged.
 */
export function externalOrigin(request: Request): string {
  const url = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (process.env.NODE_ENV === "development" || !forwardedHost) {
    return url.origin;
  }
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${forwardedHost}`;
}
