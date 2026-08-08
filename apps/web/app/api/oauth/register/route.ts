import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient, McpRefusal, registerMcpClient } from "@rooshni/db";

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
 * OAuth 2.0 Dynamic Client Registration (RFC 7591) — the Claude connector
 * flow registers itself here before the authorise redirect. Registration
 * stores redirect URIs only (no tenant data, no secret: the client is
 * public and PKCE-bound). Registering grants NOTHING: a client id only
 * earns the right to send the founder to the authorise page, where the
 * minted credential is the actual gate.
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "invalid_client_metadata", error_description: "Body must be JSON." },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const redirectUris = Array.isArray(body.redirect_uris)
    ? (body.redirect_uris as unknown[]).filter((u): u is string => typeof u === "string")
    : [];

  try {
    const db = createServiceClient();
    const { client_id } = await registerMcpClient(db, {
      clientName: typeof body.client_name === "string" ? body.client_name : undefined,
      redirectUris,
    });
    return NextResponse.json(
      {
        client_id,
        client_name: body.client_name ?? undefined,
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      { status: 201, headers: CORS_HEADERS }
    );
  } catch (error) {
    if (error instanceof McpRefusal) {
      return NextResponse.json(
        { error: "invalid_redirect_uri", error_description: error.message },
        { status: 400, headers: CORS_HEADERS }
      );
    }
    console.error("mcp client registration failed");
    return NextResponse.json(
      { error: "server_error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
