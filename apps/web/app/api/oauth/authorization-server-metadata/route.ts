import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414) — served at
 * /.well-known/oauth-authorization-server via the next.config rewrite.
 * The whole surface lives on this deployment: the authorise page sits
 * behind the app's own session gate (founder rider 2), the token endpoint
 * issues short-lived tokens bound to the minted credential (rider 1).
 */
export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  return NextResponse.json(
    {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/api/oauth/token`,
      registration_endpoint: `${origin}/api/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["read"],
    },
    { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" } }
  );
}
