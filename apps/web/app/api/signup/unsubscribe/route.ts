import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient, unsubscribeSignupNurture } from "@rooshni/db";

export const dynamic = "force-dynamic";

/**
 * Nurture unsubscribe (Session 11) — the resume token doubles as the
 * unsubscribe token: it already reaches only this signup's inbox, carries no
 * personal data in the URL, and is single-purpose to this record. Public by
 * necessity (the reader holds no session); idempotent; a stale or unknown
 * token still lands on a calm page rather than an error at a person trying
 * to opt out. The 30-day retention clock is unaffected.
 */

function page(title: string, body: string): NextResponse {
  return new NextResponse(
    `<!doctype html><html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#f7f8fb;color:#202b38;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
main{max-width:420px;padding:32px;text-align:center}h1{font-size:20px;margin:0 0 10px}p{font-size:14.5px;line-height:1.55;color:#5a6371;margin:0}</style>
</head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) {
    return page("Nothing to do", "This unsubscribe link is incomplete — no changes were made.");
  }
  try {
    const done = await unsubscribeSignupNurture(createServiceClient(), token);
    if (done) {
      return page(
        "You're unsubscribed",
        "No more setup emails from Barakah. Your saved signup stays for 30 days from the day you started it, then is deleted entirely — finishing signup any time before then still works."
      );
    }
    return page(
      "Already handled",
      "This link points at a signup that no longer exists or is already complete — either way, no more emails."
    );
  } catch {
    return page(
      "Something went wrong",
      "We couldn't process that just now. The link keeps working — try it again in a minute."
    );
  }
}
