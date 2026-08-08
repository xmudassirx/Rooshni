import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { emitEvent } from "./events";
import { MCP_EVENT_KINDS } from "./event-kinds";
import { computeLightPerformance } from "./light-performance";
import { sha256Hex } from "./conversions";

/**
 * Session 34 — the MCP read door (D188): Barakah's Model Context Protocol
 * server, read-only, grant-scoped. This module is the single TS truth for
 * the tool registry, the credential lifecycle and the OAuth wrapper; the
 * apps/web routes are thin shells over it, and the check-local harness
 * proves it directly.
 *
 * The laws it carries:
 * - D188a: every call acts as the business's "Claude via MCP" integration
 *   actor and lands on The Record via emitEvent() (law 11).
 * - D188b: READ-ONLY — the registry declares no write path; the tripwire
 *   smoke fails the harness if one ever appears.
 * - D188e: tool names follow ONE grammar, area_noun, from day one.
 * - D188g: refusals name the missing grant — the SQL door's message is
 *   surfaced verbatim, never swallowed.
 */

// ---------------------------------------------------------------------------
// Credential material. The raw credential is shown ONCE at mint and hashed
// at rest (D188c); every SQL door receives the SHA-256 digest only, so the
// raw value never enters a statement (never logged).
// ---------------------------------------------------------------------------

export const MCP_ACTOR_NAME = "Claude via MCP";
export const MCP_CREDENTIAL_PREFIX = "barakah_mcp_";

export function generateMcpSecret(prefix = MCP_CREDENTIAL_PREFIX): string {
  return `${prefix}${randomBytes(24).toString("hex")}`;
}

/** base64url(SHA-256(verifier)) — the PKCE S256 transform (RFC 7636). */
export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

// JUDGMENT: OAuth token lifetimes are protocol security parameters, not
// product timers — timeScale() governs the product's workflow durations; a
// demo-compressed access token would break the connector handshake, so
// these are real-world constants. Short-lived by founder rider 1: a token
// that lives forever quietly weakens the revoke door (refresh runs through
// the same credential-bound flow; revoke kills the whole chain).
export const MCP_CODE_TTL_MS = 10 * 60 * 1000;
export const MCP_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const MCP_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// The tool registry — the product's public face (D188e). Every entry is a
// READ: `readOnly: true` is a type-level literal and a runtime tripwire
// target; `door` is the 0045 SQL function the call lands on; `grant` names
// what the refusal will name. Descriptions are one line, written for a
// human scanning a connector list (British English, no dashes — D142).
// ---------------------------------------------------------------------------

export const MCP_TOOL_NAME_GRAMMAR = /^[a-z]+(_[a-z]+)+$/;

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly readOnly: true;
  /** The Spec 3 grant the door consumes ("per channel" where it varies). */
  readonly grant: string;
  readonly door: string;
  readonly inputSchema: Record<string, unknown>;
  /** Maps validated JSON-RPC arguments to the door's RPC parameters. */
  readonly params: (args: Record<string, unknown>) => Record<string, unknown>;
  /** Optional post-shape over the door's JSON (pure, no further reads). */
  readonly shape?: (raw: unknown) => unknown;
}

const int = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : undefined;
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "enquiries_list",
    description:
      "List the business's enquiries with stage, participants, route and value.",
    readOnly: true,
    grant: "enquiries",
    door: "mcp_enquiries_list",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Rows per page (1 to 100, default 25)." },
        offset: { type: "integer", description: "Rows to skip, for paging." },
        stage: { type: "string", description: "Filter to one stage key, e.g. new or contacted." },
      },
    },
    params: (a) => ({ p_limit: int(a.limit), p_offset: int(a.offset), p_stage: str(a.stage) }),
  },
  {
    name: "enquiry_timeline",
    description:
      "One enquiry's full timeline: stage history, message previews, ledger events and tasks.",
    readOnly: true,
    grant: "enquiries",
    door: "mcp_enquiry_timeline",
    inputSchema: {
      type: "object",
      properties: {
        enquiry_id: { type: "string", description: "The enquiry's id (UUID)." },
      },
      required: ["enquiry_id"],
    },
    params: (a) => ({ p_enquiry: str(a.enquiry_id) }),
  },
  {
    name: "threads_list",
    description:
      "List conversation threads on the channels the credential's grants cover.",
    readOnly: true,
    grant: "comms.<channel>",
    door: "mcp_threads_list",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Rows per page (1 to 100, default 25)." },
        offset: { type: "integer", description: "Rows to skip, for paging." },
      },
    },
    params: (a) => ({ p_limit: int(a.limit), p_offset: int(a.offset) }),
  },
  {
    name: "threads_read",
    description: "Read one thread's messages in full, oldest first.",
    readOnly: true,
    grant: "comms.<channel>",
    door: "mcp_threads_read",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", description: "The thread's id (UUID)." },
        limit: { type: "integer", description: "Messages to return (1 to 200, default 50)." },
      },
      required: ["thread_id"],
    },
    params: (a) => ({ p_thread: str(a.thread_id), p_limit: int(a.limit) }),
  },
  {
    name: "drafts_awaiting_stamp",
    description:
      "Drafts waiting for a human stamp in the Approval Inbox, filtered to what the grants permit.",
    readOnly: true,
    grant: "comms.<channel> / content.website / enquiries",
    door: "mcp_drafts_awaiting_stamp",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Rows to return (1 to 100, default 50)." },
      },
    },
    params: (a) => ({ p_limit: int(a.limit) }),
  },
  {
    name: "record_read",
    description:
      "Read The Record, the append-only event ledger, filtered by kind, entity and time.",
    readOnly: true,
    grant: "record",
    door: "mcp_record_read",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Filter to one event kind, e.g. communication.sent." },
        entity_type: { type: "string", description: "Filter to one entity type, e.g. engagement." },
        entity_id: { type: "string", description: "Filter to one entity id (UUID)." },
        since: { type: "string", description: "ISO timestamp lower bound (inclusive)." },
        until: { type: "string", description: "ISO timestamp upper bound (exclusive)." },
        limit: { type: "integer", description: "Rows to return (1 to 200, default 50)." },
        before_at: { type: "string", description: "Cursor: occurred_at of the last row seen." },
        before_id: { type: "string", description: "Cursor: id of the last row seen." },
      },
    },
    params: (a) => ({
      p_action: str(a.action),
      p_entity_type: str(a.entity_type),
      p_entity_id: str(a.entity_id),
      p_since: str(a.since),
      p_until: str(a.until),
      p_limit: int(a.limit),
      p_before_at: str(a.before_at),
      p_before_id: str(a.before_id),
    }),
  },
  {
    name: "workflow_definitions",
    description: "List the business's workflow definitions with their steps and status.",
    readOnly: true,
    grant: "workflows",
    door: "mcp_workflow_definitions",
    inputSchema: { type: "object", properties: {} },
    params: () => ({}),
  },
  {
    name: "workflow_runs",
    description: "List workflow runs with status, current step and timing.",
    readOnly: true,
    grant: "workflows",
    door: "mcp_workflow_runs",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter to one run status, e.g. waiting or completed." },
        limit: { type: "integer", description: "Rows per page (1 to 100, default 25)." },
        offset: { type: "integer", description: "Rows to skip, for paging." },
      },
    },
    params: (a) => ({ p_status: str(a.status), p_limit: int(a.limit), p_offset: int(a.offset) }),
  },
  {
    name: "light_performance",
    description:
      "Light's performance this week: drafts, approval rate, edits, refusals and spend.",
    readOnly: true,
    grant: "record",
    door: "mcp_light_performance",
    inputSchema: { type: "object", properties: {} },
    params: () => ({}),
    shape: (raw) => {
      const r = raw as {
        week_start: string;
        week_end: string;
        drafts_generated: number;
        stamped: number;
        rejected: number;
        edit_signals: number;
        compliance_refusals: number;
        cost_blocks: Array<Record<string, unknown> | null>;
      };
      return {
        week_start: r.week_start,
        week_end: r.week_end,
        ...computeLightPerformance({
          drafts_generated: r.drafts_generated,
          stamped: r.stamped,
          rejected: r.rejected,
          edit_signals: r.edit_signals,
          compliance_refusals: r.compliance_refusals,
          cost_blocks: r.cost_blocks ?? [],
        }),
      };
    },
  },
  {
    name: "memory_entries",
    description:
      "Read Light's Memory: business facts, standing instructions and observations.",
    readOnly: true,
    grant: "memory",
    door: "mcp_memory_entries",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "Filter: fact, instruction or observation." },
        active: { type: "boolean", description: "Filter to active (true) or superseded (false) entries." },
        limit: { type: "integer", description: "Rows per page (1 to 200, default 50)." },
        offset: { type: "integer", description: "Rows to skip, for paging." },
      },
    },
    params: (a) => ({
      p_kind: str(a.kind),
      p_active: typeof a.active === "boolean" ? a.active : undefined,
      p_limit: int(a.limit),
      p_offset: int(a.offset),
    }),
  },
] as const;

export function getMcpTool(name: string): McpToolDefinition | undefined {
  return MCP_TOOLS.find((t) => t.name === name);
}

// ---------------------------------------------------------------------------
// Authentication + the tool call. The SQL doors re-derive identity from the
// digest themselves; whoami exists so the route can event and rate-limit as
// the right actor without a door round-trip.
// ---------------------------------------------------------------------------

export interface McpIdentity {
  credential_id: string;
  actor_id: string;
  actor_name: string;
  business_id: string;
  label: string;
}

/** A refusal from the door — the message IS the product's refusal grammar
 * (names the missing grant); surface it verbatim, never swallow it. */
export class McpRefusal extends Error {}

export async function mcpWhoami(
  db: SupabaseClient,
  tokenSha256: string
): Promise<McpIdentity> {
  const { data, error } = await db.rpc("mcp_whoami", { p_token_sha256: tokenSha256 });
  if (error) throw new McpRefusal(cleanDbMessage(error.message));
  return data as McpIdentity;
}

/** Strips the PostgREST/PLpgSQL noise so the client reads the refusal. */
function cleanDbMessage(message: string): string {
  return message.replace(/^.*?(?=Actor |MCP |Enquiry |Thread )/s, "").trim() || message;
}

function summariseArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" && v.length > 120 ? `${v.slice(0, 120)}…` : v;
  }
  return out;
}

function summariseResult(result: unknown): Record<string, unknown> {
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (Array.isArray(r.items)) return { item_count: r.items.length };
    if (Array.isArray((r as { messages?: unknown[] }).messages)) {
      return { item_count: (r as { messages: unknown[] }).messages.length };
    }
  }
  return {};
}

/**
 * One MCP tool call, whole: authenticate, pass the grant-checked door,
 * event as the MCP actor (D188a), return the door's JSON. The event payload
 * is SUMMARISED — tool name, scope arguments and an item count, never the
 * response body.
 */
export async function callMcpTool(
  db: SupabaseClient,
  tokenSha256: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ identity: McpIdentity; result: unknown }> {
  const tool = getMcpTool(toolName);
  if (!tool) throw new McpRefusal(`Unknown tool "${toolName}" — call tools/list for the current set.`);

  const identity = await mcpWhoami(db, tokenSha256);

  const params: Record<string, unknown> = { p_token_sha256: tokenSha256 };
  for (const [k, v] of Object.entries(tool.params(args ?? {}))) {
    if (v !== undefined) params[k] = v;
  }

  const { data, error } = await db.rpc(tool.door, params);
  if (error) throw new McpRefusal(cleanDbMessage(error.message));
  const result = tool.shape ? tool.shape(data) : data;

  await emitEvent(db, {
    business_id: identity.business_id,
    actor_id: identity.actor_id,
    action: MCP_EVENT_KINDS.toolCalled,
    entity_type: "mcp_credential",
    entity_id: identity.credential_id,
    payload: {
      tool: toolName,
      scope: summariseArgs(args ?? {}),
      ...summariseResult(result),
    },
  });

  return { identity, result };
}

// ---------------------------------------------------------------------------
// Credential lifecycle — the Settings → Integrations door (D58/D188c).
// ---------------------------------------------------------------------------

/** The read set minted with the credential: view on every surface the ruled
 * tool set reads. approvals.* is never here — structurally unholdable by a
 * machine (0014), and the server only ever SEES the queue. */
export const MCP_GRANTED_TOOLS: readonly string[] = [
  "enquiries",
  "comms.email",
  "comms.whatsapp",
  "comms.sms",
  "comms.call",
  "comms.meeting",
  "comms.portal_message",
  "content.website",
  "record",
  "workflows",
  "memory",
] as const;

export interface MintMcpCredentialResult {
  /** The raw credential — shown ONCE, never stored, never logged. */
  secret: string;
  credentialId: string;
  actorId: string;
  grantsCreated: number;
}

export async function mintMcpCredential(
  db: SupabaseClient,
  input: { businessId: string; mintedByActorId: string; label?: string }
): Promise<MintMcpCredentialResult> {
  const { data: business, error: bizError } = await db
    .from("businesses")
    .select("id, account_id, name")
    .eq("id", input.businessId)
    .single();
  if (bizError) throw new Error(`mintMcpCredential: business lookup failed: ${bizError.message}`);

  // The machine actor, one per account, found-or-created idempotently.
  const { data: existingActor, error: actorError } = await db
    .from("actors")
    .select("id")
    .eq("account_id", business.account_id)
    .eq("actor_type", "integration")
    .eq("display_name", MCP_ACTOR_NAME)
    .is("archived_at", null)
    .maybeSingle();
  if (actorError) throw new Error(`mintMcpCredential: actor lookup failed: ${actorError.message}`);

  let actorId = existingActor?.id as string | undefined;
  if (!actorId) {
    const { data: created, error: createError } = await db
      .from("actors")
      .insert({
        account_id: business.account_id,
        actor_type: "integration",
        display_name: MCP_ACTOR_NAME,
      })
      .select("id")
      .single();
    if (createError) throw new Error(`mintMcpCredential: actor creation failed: ${createError.message}`);
    actorId = created.id as string;
  }

  const secret = generateMcpSecret();
  const { data: credential, error: credError } = await db
    .from("mcp_credentials")
    .insert({
      business_id: input.businessId,
      created_by: input.mintedByActorId,
      actor_id: actorId,
      label: input.label ?? `${MCP_ACTOR_NAME} (${business.name})`,
      token_hash: sha256Hex(secret),
    })
    .select("id")
    .single();
  if (credError) throw new Error(`mintMcpCredential: ${credError.message}`);

  // The read grants, idempotent against live rows (a re-mint after revoke
  // reuses the standing set rather than duplicating it).
  const { data: liveGrants, error: grantsError } = await db
    .from("grants")
    .select("tool, revoked_at, expires_at")
    .eq("business_id", input.businessId)
    .eq("grantee_actor_id", actorId)
    .is("revoked_at", null)
    .is("archived_at", null);
  if (grantsError) throw new Error(`mintMcpCredential: grants lookup failed: ${grantsError.message}`);
  const held = new Set(
    (liveGrants ?? [])
      .filter((g) => !g.expires_at || new Date(g.expires_at as string) > new Date())
      .map((g) => g.tool as string)
  );

  let grantsCreated = 0;
  for (const tool of MCP_GRANTED_TOOLS) {
    if (held.has(tool)) continue;
    const { error: grantError } = await db.from("grants").insert({
      business_id: input.businessId,
      created_by: input.mintedByActorId,
      grantee_actor_id: actorId,
      tool,
      access: "view",
      scope: { level: "business", ref: input.businessId },
      duration: "standing",
      granted_by_actor_id: input.mintedByActorId,
      via: "dashboard",
    });
    if (grantError) throw new Error(`mintMcpCredential: grant "${tool}" failed: ${grantError.message}`);
    grantsCreated += 1;
  }

  await emitEvent(db, {
    business_id: input.businessId,
    actor_id: input.mintedByActorId,
    action: MCP_EVENT_KINDS.credentialMinted,
    entity_type: "mcp_credential",
    entity_id: credential.id as string,
    payload: {
      actor: MCP_ACTOR_NAME,
      actor_id: actorId,
      grants_created: grantsCreated,
      tools_granted: MCP_GRANTED_TOOLS.length,
    },
  });

  return { secret, credentialId: credential.id as string, actorId, grantsCreated };
}

export async function revokeMcpCredential(
  db: SupabaseClient,
  input: { credentialId: string; revokedByActorId: string }
): Promise<void> {
  const { data: credential, error: readError } = await db
    .from("mcp_credentials")
    .select("id, business_id, revoked_at")
    .eq("id", input.credentialId)
    .single();
  if (readError) throw new Error(`revokeMcpCredential: ${readError.message}`);
  if (credential.revoked_at) return;

  const { error } = await db
    .from("mcp_credentials")
    .update({
      revoked_at: new Date().toISOString(),
      revoked_by_actor_id: input.revokedByActorId,
    })
    .eq("id", input.credentialId);
  if (error) throw new Error(`revokeMcpCredential: ${error.message}`);

  await emitEvent(db, {
    business_id: credential.business_id as string,
    actor_id: input.revokedByActorId,
    action: MCP_EVENT_KINDS.credentialRevoked,
    entity_type: "mcp_credential",
    entity_id: input.credentialId,
    payload: { actor: MCP_ACTOR_NAME },
  });
}

// ---------------------------------------------------------------------------
// The OAuth wrapper (founder-approved 8 Aug 2026): metadata + register +
// authorise + token on our own deployment; every issued artefact hashed and
// bound to the credential row, so revoke kills the chain.
// ---------------------------------------------------------------------------

export async function registerMcpClient(
  db: SupabaseClient,
  input: { clientName?: string; redirectUris: string[] }
): Promise<{ client_id: string }> {
  const uris = (input.redirectUris ?? []).filter(
    (u) => typeof u === "string" && /^https:\/\//.test(u)
  );
  if (uris.length === 0) {
    throw new McpRefusal("registration requires at least one https redirect_uri");
  }
  const clientId = `mcp_client_${randomBytes(16).toString("hex")}`;
  const { error } = await db.from("mcp_clients").insert({
    client_id: clientId,
    client_name: input.clientName ?? null,
    redirect_uris: uris,
  });
  if (error) throw new Error(`registerMcpClient: ${error.message}`);
  return { client_id: clientId };
}

export interface AuthorizeInput {
  /** The raw minted credential the founder pastes on the authorise page. */
  credentialSecret: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
}

export async function createAuthorizationCode(
  db: SupabaseClient,
  input: AuthorizeInput
): Promise<{ code: string; redirectUri: string }> {
  if (input.codeChallengeMethod !== "S256") {
    throw new McpRefusal("only PKCE S256 is supported");
  }

  const { data: client, error: clientError } = await db
    .from("mcp_clients")
    .select("client_id, redirect_uris")
    .eq("client_id", input.clientId)
    .maybeSingle();
  if (clientError) throw new Error(`createAuthorizationCode: ${clientError.message}`);
  if (!client) throw new McpRefusal("unknown client_id — register the client first");
  const uris = (client.redirect_uris as string[]) ?? [];
  if (!uris.includes(input.redirectUri)) {
    throw new McpRefusal("redirect_uri does not match the client's registration");
  }

  const { data: credential, error: credError } = await db
    .from("mcp_credentials")
    .select("id, business_id")
    .eq("token_hash", sha256Hex(input.credentialSecret))
    .is("revoked_at", null)
    .is("archived_at", null)
    .maybeSingle();
  if (credError) throw new Error(`createAuthorizationCode: ${credError.message}`);
  if (!credential) {
    throw new McpRefusal(
      "credential not recognised or revoked — mint one in Settings, then paste it here"
    );
  }

  const code = `mcp_code_${randomBytes(24).toString("hex")}`;
  const { error } = await db.from("mcp_tokens").insert({
    credential_id: credential.id,
    business_id: credential.business_id,
    kind: "authorization_code",
    token_hash: sha256Hex(code),
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code_challenge: input.codeChallenge,
    expires_at: new Date(Date.now() + MCP_CODE_TTL_MS).toISOString(),
  });
  if (error) throw new Error(`createAuthorizationCode: ${error.message}`);

  return { code, redirectUri: input.redirectUri };
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
}

async function issueTokenPair(
  db: SupabaseClient,
  credentialId: string,
  businessId: string,
  clientId: string | null
): Promise<TokenResponse> {
  const accessToken = `mcp_at_${randomBytes(24).toString("hex")}`;
  const refreshToken = `mcp_rt_${randomBytes(24).toString("hex")}`;
  const { error } = await db.from("mcp_tokens").insert([
    {
      credential_id: credentialId,
      business_id: businessId,
      kind: "access_token",
      token_hash: sha256Hex(accessToken),
      client_id: clientId,
      expires_at: new Date(Date.now() + MCP_ACCESS_TOKEN_TTL_MS).toISOString(),
    },
    {
      credential_id: credentialId,
      business_id: businessId,
      kind: "refresh_token",
      token_hash: sha256Hex(refreshToken),
      client_id: clientId,
      expires_at: new Date(Date.now() + MCP_REFRESH_TOKEN_TTL_MS).toISOString(),
    },
  ]);
  if (error) throw new Error(`issueTokenPair: ${error.message}`);
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.floor(MCP_ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: refreshToken,
  };
}

export async function exchangeAuthorizationCode(
  db: SupabaseClient,
  input: { code: string; codeVerifier: string; clientId: string; redirectUri: string }
): Promise<TokenResponse> {
  const { data: row, error } = await db
    .from("mcp_tokens")
    .select("id, credential_id, business_id, client_id, redirect_uri, code_challenge, expires_at, consumed_at")
    .eq("token_hash", sha256Hex(input.code))
    .eq("kind", "authorization_code")
    .maybeSingle();
  if (error) throw new Error(`exchangeAuthorizationCode: ${error.message}`);
  if (!row || row.consumed_at || new Date(row.expires_at as string) <= new Date()) {
    throw new McpRefusal("authorisation code invalid, expired or already used");
  }
  if (row.client_id !== input.clientId || row.redirect_uri !== input.redirectUri) {
    throw new McpRefusal("client_id or redirect_uri does not match the authorisation");
  }
  if (pkceS256(input.codeVerifier) !== row.code_challenge) {
    throw new McpRefusal("PKCE verification failed");
  }

  const { error: consumeError } = await db
    .from("mcp_tokens")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", row.id);
  if (consumeError) throw new Error(`exchangeAuthorizationCode: ${consumeError.message}`);

  return issueTokenPair(db, row.credential_id as string, row.business_id as string, input.clientId);
}

export async function exchangeRefreshToken(
  db: SupabaseClient,
  input: { refreshToken: string; clientId: string }
): Promise<TokenResponse> {
  const { data: row, error } = await db
    .from("mcp_tokens")
    .select("id, credential_id, business_id, client_id, expires_at, consumed_at, mcp_credentials!inner(revoked_at, archived_at)")
    .eq("token_hash", sha256Hex(input.refreshToken))
    .eq("kind", "refresh_token")
    .maybeSingle();
  if (error) throw new Error(`exchangeRefreshToken: ${error.message}`);
  const credential = row?.mcp_credentials as { revoked_at: string | null; archived_at: string | null } | undefined;
  if (
    !row ||
    row.consumed_at ||
    new Date(row.expires_at as string) <= new Date() ||
    !credential ||
    credential.revoked_at ||
    credential.archived_at
  ) {
    throw new McpRefusal("refresh token invalid, expired or revoked — reconnect from Settings");
  }

  // Rotation: the old refresh token is consumed; a fresh pair is issued.
  const { error: consumeError } = await db
    .from("mcp_tokens")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", row.id);
  if (consumeError) throw new Error(`exchangeRefreshToken: ${consumeError.message}`);

  return issueTokenPair(db, row.credential_id as string, row.business_id as string, input.clientId);
}

// ---------------------------------------------------------------------------
// Rate limiting — in-memory sliding window per credential. JUDGMENT: the
// marketing demo route's pattern, per instance and lost on cold start; sane
// for an audience of one founder, honest about not being a distributed
// limiter, and it adds no infrastructure (D188d).
// ---------------------------------------------------------------------------

export class McpRateLimiter {
  private readonly log = new Map<string, number[]>();
  constructor(
    private readonly max = 120,
    private readonly windowMs = 60 * 1000
  ) {}

  /** Returns true when the call is allowed; false when the window is full. */
  allow(key: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const entries = (this.log.get(key) ?? []).filter((t) => t > cutoff);
    if (entries.length >= this.max) {
      this.log.set(key, entries);
      return false;
    }
    entries.push(now);
    this.log.set(key, entries);
    return true;
  }
}
