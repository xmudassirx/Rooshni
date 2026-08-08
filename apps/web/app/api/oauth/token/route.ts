import { NextResponse, type NextRequest } from "next/server";
import {
  createServiceClient,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  McpRefusal,
} from "@rooshni/db";

export const dynamic = "force-dynamic";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * The token endpoint. Codes are one-time, PKCE-verified (S256) and expire in
 * minutes; access tokens are short-lived and refresh tokens rotate — every
 * artefact is hashed at rest and bound to the minted credential, so a revoke
 * in Settings kills the whole chain at once (founder rider 1).
 */
export async function POST(request: NextRequest) {
  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await request.text());
  } catch {
    return oauthError("invalid_request", "Body must be application/x-www-form-urlencoded.");
  }

  const grantType = form.get("grant_type") ?? "";
  const clientId = form.get("client_id") ?? "";
  const db = createServiceClient();

  try {
    if (grantType === "authorization_code") {
      const token = await exchangeAuthorizationCode(db, {
        code: form.get("code") ?? "",
        codeVerifier: form.get("code_verifier") ?? "",
        clientId,
        redirectUri: form.get("redirect_uri") ?? "",
      });
      return NextResponse.json(token, { headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
    }
    if (grantType === "refresh_token") {
      const token = await exchangeRefreshToken(db, {
        refreshToken: form.get("refresh_token") ?? "",
        clientId,
      });
      return NextResponse.json(token, { headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
    }
    return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
  } catch (error) {
    if (error instanceof McpRefusal) {
      return oauthError("invalid_grant", error.message);
    }
    console.error("mcp token exchange failed");
    return oauthError("server_error", "Token exchange failed.", 500);
  }
}

function oauthError(error: string, description: string, status = 400) {
  return NextResponse.json(
    { error, error_description: description },
    { status, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } }
  );
}
