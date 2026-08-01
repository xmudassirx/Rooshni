import { randomUUID } from "node:crypto";
import { ProviderRejectedError, type SendResult } from "./send";

/**
 * Microsoft Graph mail — the firm's outbound email carrier (Session 10).
 *
 * App-only (client credentials) against the firm's tenant; sends AS the firm
 * from GRAPH_SENDER_ADDRESS. Tenant comms only — platform mail rides Resend
 * and the two pipes never mix (decision 87).
 *
 * One-shot /sendMail with a SELF-MINTED RFC 5322 internetMessageId — the
 * least-privilege shape: only the Mail.Send application permission is
 * needed (create-then-send would also demand Mail.ReadWrite, and its
 * create step is what "Access is denied" refused on the first live
 * dispatch). Graph honours a caller-supplied internetMessageId, so the
 * sent row still carries the provider message id.
 * External calls fail; explicit timeouts, and a Graph 4xx becomes a
 * ProviderRejectedError (visible failed state) while 5xx/network stays
 * transient (row remains approved; the next tick retries).
 */

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const TIMEOUT_MS = 15_000;

interface GraphEnv {
  clientId: string;
  tenantId: string;
  clientSecret: string;
  senderAddress: string;
}

export function readGraphEnv(env: NodeJS.ProcessEnv = process.env): GraphEnv | null {
  const clientId = env.AZURE_CLIENT_ID;
  const tenantId = env.AZURE_TENANT_ID;
  const clientSecret = env.AZURE_CLIENT_SECRET;
  const senderAddress = env.GRAPH_SENDER_ADDRESS;
  if (!clientId || !tenantId || !clientSecret || !senderAddress) return null;
  return { clientId, tenantId, clientSecret, senderAddress };
}

let tokenCache: { token: string; expiresAt: number } | null = null;

async function getGraphToken(env: GraphEnv): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  const response = await fetch(`https://login.microsoftonline.com/${env.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.clientId,
      client_secret: env.clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await response.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!response.ok || !body.access_token) {
    throw new Error(`Graph token request failed (${response.status}): ${body.error_description ?? "unknown error"}`);
  }
  tokenCache = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return body.access_token;
}

async function graphJson<T>(
  token: string,
  method: string,
  path: string,
  payload?: unknown
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${GRAPH_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  const body = (text ? JSON.parse(text) : {}) as T;
  return { status: response.status, body };
}

/** One inbound mail as the poll reads it (Session 16, PR-A). */
export interface GraphInboundMessage {
  id: string;
  internetMessageId: string | null;
  receivedDateTime: string;
  subject: string | null;
  fromAddress: string | null;
  fromName: string | null;
  /** Plain-text body (Prefer: outlook.body-content-type="text"). */
  bodyText: string;
  /** RFC 5322 message ids this mail replies into (In-Reply-To + References). */
  referenceIds: string[];
}

export interface GraphInboundReader {
  mailbox: string;
  /** New inbox mail strictly after the cursor, oldest first, capped. */
  listNewMessages: (sinceIso: string, top?: number) => Promise<
    Array<{ id: string; internetMessageId: string | null; receivedDateTime: string; subject: string | null; fromAddress: string | null; fromName: string | null }>
  >;
  /** Full detail for one message: text body + reply headers. */
  getMessage: (id: string) => Promise<GraphInboundMessage>;
}

/** Extract every <rfc-id> from In-Reply-To/References header values. */
export function parseReferenceIds(headerValues: string[]): string[] {
  const ids = new Set<string>();
  for (const value of headerValues) {
    for (const match of value.matchAll(/<[^<>\s]+>/g)) ids.add(match[0]);
  }
  return [...ids];
}

/**
 * Builds the inbound mailbox reader, or null when Graph is not configured
 * (the poll then reports itself absent — a visible no-op, never a silent
 * one). Reading the tenant mailbox needs the Mail.Read APPLICATION
 * permission with admin consent on the existing app registration — the
 * send path deliberately holds Mail.Send only (least privilege), so until
 * consent is granted every read returns Graph's ErrorAccessDenied, which
 * the poll records as a visible failure (Lane C credentials-at-need: the
 * console steps are the founder's, listed in the session close report).
 */
export function createGraphInboundReader(
  env: NodeJS.ProcessEnv = process.env
): GraphInboundReader | null {
  const graphEnv = readGraphEnv(env);
  if (!graphEnv) return null;
  const mailbox = graphEnv.senderAddress;

  const listNewMessages = async (sinceIso: string, top = 25) => {
    const token = await getGraphToken(graphEnv);
    const select = "id,internetMessageId,receivedDateTime,subject,from";
    const filter = encodeURIComponent(`receivedDateTime gt ${sinceIso}`);
    const path =
      `/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages` +
      `?$filter=${filter}&$orderby=receivedDateTime asc&$top=${top}&$select=${select}`;
    const { status, body } = await graphJson<{
      value?: Array<{
        id: string;
        internetMessageId?: string;
        receivedDateTime: string;
        subject?: string;
        from?: { emailAddress?: { address?: string; name?: string } };
      }>;
      error?: { code?: string; message?: string };
    }>(token, "GET", path);
    if (status >= 400) {
      throw new Error(`Graph inbox list failed (${status} ${body.error?.code ?? ""}): ${body.error?.message ?? "unknown error"}`);
    }
    return (body.value ?? []).map((m) => ({
      id: m.id,
      internetMessageId: m.internetMessageId ?? null,
      receivedDateTime: m.receivedDateTime,
      subject: m.subject ?? null,
      fromAddress: m.from?.emailAddress?.address?.toLowerCase() ?? null,
      fromName: m.from?.emailAddress?.name ?? null,
    }));
  };

  const getMessage = async (id: string): Promise<GraphInboundMessage> => {
    const token = await getGraphToken(graphEnv);
    const select = "id,internetMessageId,receivedDateTime,subject,from,body,internetMessageHeaders";
    const path = `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(id)}?$select=${select}`;
    const response = await fetch(`${GRAPH_BASE}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Prefer: 'outlook.body-content-type="text"',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as {
      id?: string;
      internetMessageId?: string;
      receivedDateTime?: string;
      subject?: string;
      from?: { emailAddress?: { address?: string; name?: string } };
      body?: { content?: string };
      internetMessageHeaders?: Array<{ name: string; value: string }>;
      error?: { code?: string; message?: string };
    };
    if (!response.ok || !body.id) {
      throw new Error(`Graph message fetch failed (${response.status} ${body.error?.code ?? ""}): ${body.error?.message ?? "unknown error"}`);
    }
    const replyHeaders = (body.internetMessageHeaders ?? [])
      .filter((h) => /^(in-reply-to|references)$/i.test(h.name))
      .map((h) => h.value);
    return {
      id: body.id,
      internetMessageId: body.internetMessageId ?? null,
      receivedDateTime: body.receivedDateTime ?? new Date().toISOString(),
      subject: body.subject ?? null,
      fromAddress: body.from?.emailAddress?.address?.toLowerCase() ?? null,
      fromName: body.from?.emailAddress?.name ?? null,
      bodyText: body.body?.content ?? "",
      referenceIds: parseReferenceIds(replyHeaders),
    };
  };

  return { mailbox, listNewMessages, getMessage };
}

/** Builds the email carrier, or null when Graph is not configured (the
 * dispatcher then leaves email rows approved and says so in its report). */
export function createGraphEmailSender(
  env: NodeJS.ProcessEnv = process.env
): ((input: { to: string; subject: string | null; body: string; bodyFormat: string }) => Promise<SendResult>) | null {
  const graphEnv = readGraphEnv(env);
  if (!graphEnv) return null;

  return async (input) => {
    const token = await getGraphToken(graphEnv);
    const senderDomain = graphEnv.senderAddress.split("@")[1] ?? "barakah.invalid";
    const internetMessageId = `<${randomUUID()}@${senderDomain}>`;

    const sent = await graphJson<{ error?: { message?: string } }>(
      token,
      "POST",
      `/users/${encodeURIComponent(graphEnv.senderAddress)}/sendMail`,
      {
        message: {
          subject: input.subject ?? "",
          body: {
            contentType: input.bodyFormat === "html" ? "HTML" : "Text",
            content: input.body,
          },
          toRecipients: [{ emailAddress: { address: input.to } }],
          internetMessageId,
        },
        saveToSentItems: true,
      }
    );
    if (sent.status >= 400) {
      const detail = sent.body.error?.message ?? `HTTP ${sent.status}`;
      if (sent.status < 500) {
        throw new ProviderRejectedError(`Graph refused the send: ${detail}`, "graph");
      }
      throw new Error(`Graph send failed: ${detail}`);
    }

    return {
      provider: "graph",
      providerMessageId: internetMessageId,
    };
  };
}
