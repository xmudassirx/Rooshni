import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728) for the MCP endpoint —
 * served at /.well-known/oauth-protected-resource via the next.config
 * rewrite. This is how an MCP client discovers the authorisation server
 * (which is this same deployment: no third party, D188d).
 */
export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  return NextResponse.json(
    {
      resource: `${origin}/api/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      scopes_supported: ["read"],
      resource_name: "Barakah (read-only)",
    },
    { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" } }
  );
}
