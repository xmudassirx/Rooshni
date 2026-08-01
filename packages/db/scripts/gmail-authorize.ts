import { createServer } from "node:http";
import { loadEnv } from "./env";

/**
 * Mint the Gmail refresh token for the tenant mailbox (Session 20 — the
 * founder's wiring step, run locally, once per mailbox).
 *
 *   npm run gmail:authorize --workspace=@rooshni/db
 *
 * Needs GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET in .env.local (from the
 * Google Cloud consent config — console steps in the session close report).
 * The script starts a localhost listener, prints the consent URL, and when
 * the founder signs in AS THE FIRM'S MAILBOX and approves, exchanges the
 * one-time code and prints the refresh token to the founder's own terminal
 * — the delivery mechanism, nothing is written to any file. Place the value
 * in .env.local and Vercel as GMAIL_REFRESH_TOKEN; it is a secret (GO-LIVE
 * carries its rotation note).
 *
 * Scopes: gmail.send + gmail.readonly ONLY — carriage and the inbound poll,
 * least privilege, nothing else.
 */

const REDIRECT_PORT = 8765;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const SCOPES = "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly";

async function main() {
  loadEnv();
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error(
      "GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be in .env.local first (the Google Cloud consent config)."
    );
    process.exit(1);
  }

  const consentUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: SCOPES,
      access_type: "offline",
      prompt: "consent",
    }).toString();

  console.log("\n1. Open this URL in a browser signed in as the FIRM'S Workspace mailbox:\n");
  console.log(`   ${consentUrl}\n`);
  console.log(`2. Approve. The browser lands on ${REDIRECT_URI} and this script finishes.\n`);

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT_URI);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get("error");
      const got = url.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(err ? `Authorisation failed: ${err}. Close this tab.` : "Authorised. Close this tab and return to the terminal.");
      server.close();
      if (err) reject(new Error(`consent refused: ${err}`));
      else if (got) resolve(got);
      else reject(new Error("no code on the callback"));
    });
    server.listen(REDIRECT_PORT);
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    }).toString(),
  });
  const body = (await response.json()) as { refresh_token?: string; error_description?: string; error?: string };
  if (!response.ok || !body.refresh_token) {
    throw new Error(
      `token exchange failed (${response.status}): ${body.error_description ?? body.error ?? "no refresh_token returned — re-run and ensure prompt=consent was honoured"}`
    );
  }

  console.log("Refresh token minted. Place it in .env.local and Vercel as:\n");
  console.log(`   GMAIL_REFRESH_TOKEN=${body.refresh_token}\n`);
  console.log("Set GMAIL_SENDER_ADDRESS to the mailbox you just signed in as, then bind inbound:");
  console.log("   npm run wire-inbound --workspace=@rooshni/db -- --gmail <that mailbox> <business_id>\n");
}

main().catch((err) => {
  console.error("gmail:authorize failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
