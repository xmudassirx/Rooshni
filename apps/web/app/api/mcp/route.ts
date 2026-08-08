import { NextResponse, type NextRequest } from "next/server";
import {
  callMcpTool,
  createServiceClient,
  McpRateLimiter,
  McpRefusal,
  mcpWhoami,
  MCP_TOOLS,
  sha256Hex,
} from "@rooshni/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The MCP endpoint (Session 34, D188) — streamable HTTP per the current MCP
 * specification: one endpoint, JSON-RPC over POST, JSON responses (the spec
 * permits a single application/json object per request; this server opens
 * no SSE streams and holds no sessions — every request authenticates
 * itself). GET and DELETE answer 405 as the spec allows for a server that
 * offers no server-initiated stream and no session teardown.
 *
 * JUDGMENT: the JSON-RPC shell is hand-rolled rather than pulled from the
 * SDK — the official TS SDK's server transport wants a Node http response
 * to stream on, which a Next route handler does not hold; for a stateless
 * tools-only server the shell is ~200 lines against the spec, adds no
 * dependency, and the doors behind it stay the product's own. If a future
 * session adopts the SDK, the registry in @rooshni/db carries across
 * unchanged.
 *
 * Auth FAILS CLOSED: no bearer, unknown bearer, revoked credential or
 * expired token all answer 401 with the OAuth discovery header (RFC 9728),
 * which is exactly what steers a Claude client into the connect flow.
 * Every tool call lands on The Record as "Claude via MCP" (D188a).
 */

/** Handshake-based protocol revisions this server speaks. Anthropic clients
 * currently negotiate 2025-11-25 or earlier; the negotiation rule is the
 * spec's: echo a supported requested version, else offer our latest. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

const limiter = new McpRateLimiter(120, 60 * 1000);

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate",
};

function json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
  return NextResponse.json(body, {
    status: init?.status ?? 200,
    headers: { ...CORS_HEADERS, ...init?.headers },
  });
}

function rpcError(id: unknown, code: number, message: string) {
  return json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function unauthorised(request: NextRequest, message: string) {
  const origin = request.nextUrl.origin;
  return json(
    { jsonrpc: "2.0", id: null, error: { code: -32001, message } },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", error="invalid_token"`,
      },
    }
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET() {
  // No server-initiated stream: the spec's 405 branch.
  return json(
    { error: "This MCP endpoint accepts JSON-RPC over POST only." },
    { status: 405, headers: { Allow: "POST, OPTIONS" } }
  );
}

export async function DELETE() {
  // Stateless: there is no session to terminate.
  return json({ error: "No session to terminate." }, { status: 405, headers: { Allow: "POST, OPTIONS" } });
}

export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!bearer) {
    return unauthorised(request, "Authentication required — connect this server through its OAuth flow.");
  }
  const tokenSha256 = sha256Hex(bearer);

  let message: Record<string, unknown>;
  try {
    message = (await request.json()) as Record<string, unknown>;
  } catch {
    return rpcError(null, -32700, "Parse error: the body must be a single JSON-RPC message.");
  }
  if (Array.isArray(message)) {
    return rpcError(null, -32600, "Batching is not supported — send one JSON-RPC message per request.");
  }

  const db = createServiceClient();
  const method = String(message.method ?? "");
  const id = message.id as string | number | null | undefined;
  const params = (message.params ?? {}) as Record<string, unknown>;

  // Authenticate every message; the doors re-derive identity themselves.
  let identity;
  try {
    identity = await mcpWhoami(db, tokenSha256);
  } catch (error) {
    const detail = error instanceof McpRefusal ? error.message : "Credential not recognised.";
    return unauthorised(request, detail);
  }

  if (!limiter.allow(identity.credential_id)) {
    return json(
      { jsonrpc: "2.0", id: id ?? null, error: { code: -32000, message: "Rate limit reached — try again shortly." } },
      { status: 429, headers: { "Retry-After": "30" } }
    );
  }

  // Notifications get 202 Accepted with no body (the spec's rule).
  if (id === undefined || id === null) {
    return new NextResponse(null, { status: 202, headers: CORS_HEADERS });
  }

  switch (method) {
    case "initialize": {
      const requested = String(params.protocolVersion ?? "");
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      return json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: "barakah",
            title: `Barakah (read-only) — ${identity.label}`,
            version: "1.0.0",
          },
          instructions:
            "Read-only view of the business as the actor 'Claude via MCP'. " +
            "Every call is grant-checked and lands on The Record. " +
            "Refusals name the missing grant.",
        },
      });
    }

    case "ping":
      return json({ jsonrpc: "2.0", id, result: {} });

    case "tools/list":
      return json({
        jsonrpc: "2.0",
        id,
        result: {
          tools: MCP_TOOLS.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
          })),
        },
      });

    case "tools/call": {
      const toolName = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const { result } = await callMcpTool(db, tokenSha256, toolName, args);
        return json({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
            isError: false,
          },
        });
      } catch (error) {
        if (error instanceof McpRefusal) {
          // A refusal is a tool RESULT, not a protocol error: the client's
          // model reads the named missing grant (D188g).
          return json({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: error.message }], isError: true },
          });
        }
        console.error("mcp tools/call failed", { tool: toolName });
        return rpcError(id, -32603, "Internal error executing the tool.");
      }
    }

    default:
      return rpcError(id, -32601, `Method "${method}" is not supported by this server.`);
  }
}
