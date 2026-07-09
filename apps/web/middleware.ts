import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Session 5 — every app route sits behind this gate.
 *
 * 1. Refresh the Supabase session (the only place cookies are reliably
 *    writable on every request).
 * 2. Decide who is at the door: no session, or a session whose email is not
 *    on the allowlist, sees the public holding page — the URL never changes
 *    (rewrite, not redirect), so the app's shape is not advertised.
 *
 * The allowlist check runs under the visitor's own RLS: allowed_emails shows
 * a signed-in user their own live row or nothing (0018). Even if this gate
 * were bypassed entirely, a stranger holds no membership — RLS would show
 * them zero rows on every table. The middleware is the door; the database is
 * the wall.
 */

// Reachable without a session. Everything else is the app.
const PUBLIC_PATHS = ["/construction", "/signin", "/auth", "/api/health"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );
}

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set."
    );
  }

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Always call getUser() first: it refreshes an expiring session, and its
  // cookie writes must land on whichever response we return.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // A one-time OAuth ?code= that landed anywhere but the callback (Supabase
  // falls back to the Site URL when a redirect misses its allowlist) would
  // otherwise strand the sign-in on that page — a sign-in loop. Send it to
  // the exchange instead.
  const oauthCode = request.nextUrl.searchParams.get("code");
  if (!user && oauthCode && !request.nextUrl.pathname.startsWith("/auth/")) {
    const callbackUrl = new URL("/auth/callback", request.url);
    callbackUrl.searchParams.set("code", oauthCode);
    const redirect = NextResponse.redirect(callbackUrl);
    for (const cookie of response.cookies.getAll()) {
      redirect.cookies.set(cookie);
    }
    return redirect;
  }

  if (isPublic(request.nextUrl.pathname)) {
    return response;
  }

  const holdingPage = () => {
    const rewritten = NextResponse.rewrite(
      new URL("/construction", request.url)
    );
    for (const cookie of response.cookies.getAll()) {
      rewritten.cookies.set(cookie);
    }
    return rewritten;
  };

  if (!user) {
    return holdingPage();
  }

  // RLS answers "am I allowlisted?" — one live row for yes, nothing for no.
  const { data: allowed, error } = await supabase
    .from("allowed_emails")
    .select("id")
    .limit(1);
  if (error || !allowed?.length) {
    return holdingPage();
  }

  return response;
}

export const config = {
  // Everything except Next.js internals and static assets.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)",
  ],
};
