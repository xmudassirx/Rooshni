# Barakah over MCP — the read-only server (D188)

Barakah exposes a Model Context Protocol server so an external AI client
can read the business on the founder's behalf. It is a route on the
existing web deployment (streamable HTTP, JSON-RPC over POST at
`/api/mcp`) — nothing runs on the founder's machine, no new
infrastructure.

## The laws (D188, verbatim in DECISIONS.md)

- **Its own actor.** Every call acts as the business's machine actor
  "Claude via MCP" — grant-scoped through the Spec 3 model, never
  service-role authority, never raw tables. Every tool call is a
  grant-checked security-definer read door (0045).
- **Read-only in this era.** No stamping, no drafting, no stage moves, no
  memory writes. The tool registry declares no write path; a check-local
  tripwire fails the harness if one ever appears. Any write capability is
  a separate founder ruling.
- **Tenant-scoped, hashed, revocable.** The credential is minted per
  business in Settings → Integrations (the one door, D58), stored as a
  SHA-256 digest, shown once at mint, never logged, revocable there.
  OAuth tokens are short-lived, bound to the credential row, and die on
  revoke.
- **Evented.** Every tool call lands on The Record as `mcp.tool_called`
  by "Claude via MCP", with the tool name and a summarised scope — never
  the response body.
- **Fail-loud.** Responses carry what the grants permit and nothing
  else; a refusal names the missing grant.

## Connecting from a Claude client (the founder's walkthrough)

1. **Mint the credential.** Settings → Integrations → the "Claude (MCP)"
   row → Mint credential (owner only). Copy the credential — it is shown
   once. Copy the endpoint URL from the same row (it is
   `https://<the app's domain>/api/mcp`).
2. **Add the connector.** In Claude (web or desktop): Settings →
   Connectors → Add custom connector. Paste the endpoint URL. Claude
   discovers the OAuth surface automatically (the RFC 9728/8414 metadata
   this deployment serves).
3. **Authorise.** Claude opens Barakah's authorise page. Be signed in to
   Barakah first (the page sits behind the app's own session gate — a
   signed-out visitor sees the holding page; sign in, then restart the
   connect from Claude). The page states what is granted in the
   product's own register: read-only access to the business as the actor
   "Claude via MCP", every call on The Record. Paste the minted
   credential and choose "Authorise read-only access".
4. **Done.** Barakah appears in the connector list with its tools named
   in the one grammar. Asking Claude "what drafts await my stamp?" calls
   `drafts_awaiting_stamp`; the call stands on The Record.

Revoking: Settings → Integrations → the row's Revoke. Permanent; every
token bound to the credential dies at once. Mint again to reconnect.

The connection chip on the Settings row is **earned**: it reads
"connected" only after a real authenticated call has stamped
`last_used_at` — never at mint.

## The tools

All names follow the `area_noun` grammar (D188e). All are read-only.

| Tool | What it reads | Grant consumed (view) |
|---|---|---|
| `enquiries_list` | Enquiries with stage, participants, route and value | `enquiries` |
| `enquiry_timeline` | One enquiry: stage history, message previews, events, tasks | `enquiries` |
| `threads_list` | Conversation threads on granted channels | `comms.<channel>` per channel |
| `threads_read` | One thread's messages in full | `comms.<channel>` of that thread |
| `drafts_awaiting_stamp` | The Approval Inbox queue, filtered to granted arms | `comms.<channel>` / `content.website` / `enquiries` |
| `record_read` | The Record (events ledger), filtered by kind/entity/time | `record` |
| `workflow_definitions` | Workflow definitions and steps | `workflows` |
| `workflow_runs` | Workflow runs with status and current step | `workflows` |
| `light_performance` | Light's weekly tile: drafts, approval rate, edits, spend | `record` |
| `memory_entries` | Light's Memory: facts, instructions, observations | `memory` |

Timeline previews are truncated to 240 characters; full bodies require
`threads_read` and its channel grant — responses carry what the grants
permit (D188g).

The `approvals.*` tools are structurally unholdable by the machine actor
(0014): the server sees the stamp queue and can never stamp it.

## The machinery (for future sessions)

- **Registry:** `packages/db/src/mcp.ts` — tool names, descriptions,
  input schemas, door mapping, credential/OAuth lifecycle. The
  check-local tripwires read this registry: every entry `readOnly: true`,
  every name matching the grammar.
- **Doors:** `packages/db/migrations/0045_mcp_read_door.sql` — one
  security-definer function per tool; the grant check
  (`private.consume_grant`, the 0015 pattern) is the authorisation, not
  the route. Callable by service_role only; the route's only database
  surface.
- **Route:** `apps/web/app/api/mcp/route.ts` — stateless JSON-RPC shell
  (initialize / tools/list / tools/call / ping), 401 + OAuth discovery on
  a missing or dead bearer, in-memory rate limiting per credential.
- **OAuth:** `apps/web/app/api/oauth/*` + `/oauth/authorize` +
  next.config rewrites for the two `/.well-known` documents. Codes are
  one-time and PKCE-verified; access tokens expire in 60 minutes;
  refresh tokens rotate and expire in 30 days; everything hashed and
  credential-bound.

## The growth rule (D188e)

The tool list is the product's public face and will grow for years. A
future session adding a capability:

1. adds the read door in a NEW migration (never editing 0045),
2. adds the registry entry in `packages/db/src/mcp.ts` — name in the
   `area_noun` grammar, one-line description written for a human scanning
   a connector list, `readOnly: true` while D188b stands,
3. updates the tool table in THIS document, in the same diff.

Every connected client discovers the addition at its next handshake —
no reconnection, no URL change. A WRITE tool is not a registry edit: it
is a separate founder ruling first (D188b).
