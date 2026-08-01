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

/** Graph's one-shot /sendMail carries inline attachments up to ~3MB of
 * request body; anything larger needs the draft-message + upload-session
 * flow (which requires the Mail.ReadWrite application permission — a
 * GO-LIVE console step; until consent is granted a 3–8MB attachment fails
 * VISIBLY with Graph's ErrorAccessDenied, never silently).
 * JUDGMENT: the ruled 8MB ceiling is honoured by splitting carriage —
 * ≤3MB rides the least-privilege one-shot path unchanged; 3–8MB takes the
 * large path behind the GO-LIVE consent. Provider mechanics, flagged at
 * pre-flight; awaiting sign-off at close. */
const INLINE_ATTACHMENT_LIMIT = 3 * 1024 * 1024;
const UPLOAD_CHUNK_BYTES = 3 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 60_000;

interface GraphAttachment {
  filename: string;
  mimeType: string;
  contentBase64: string;
}

function attachmentBytes(att: GraphAttachment): number {
  // Decoded size from base64 length — close enough for the path choice.
  return Math.floor((att.contentBase64.length * 3) / 4);
}

/** Builds the email carrier, or null when Graph is not configured (the
 * dispatcher then leaves email rows approved and says so in its report). */
export function createGraphEmailSender(
  env: NodeJS.ProcessEnv = process.env
): ((input: {
  to: string;
  subject: string | null;
  body: string;
  bodyFormat: string;
  attachments?: GraphAttachment[];
}) => Promise<SendResult>) | null {
  const graphEnv = readGraphEnv(env);
  if (!graphEnv) return null;

  const refuseOn4xx = (status: number, detail: string, what: string): never => {
    if (status < 500) throw new ProviderRejectedError(`Graph refused the ${what}: ${detail}`, "graph");
    throw new Error(`Graph ${what} failed: ${detail}`);
  };

  return async (input) => {
    const token = await getGraphToken(graphEnv);
    const senderDomain = graphEnv.senderAddress.split("@")[1] ?? "barakah.invalid";
    const internetMessageId = `<${randomUUID()}@${senderDomain}>`;
    const userPath = `/users/${encodeURIComponent(graphEnv.senderAddress)}`;

    const attachments = input.attachments ?? [];
    const totalAttachmentBytes = attachments.reduce((sum, a) => sum + attachmentBytes(a), 0);
    const message = {
      subject: input.subject ?? "",
      body: {
        contentType: input.bodyFormat === "html" ? "HTML" : "Text",
        content: input.body,
      },
      toRecipients: [{ emailAddress: { address: input.to } }],
      internetMessageId,
    };

    // The one-shot least-privilege path (Mail.Send only): no attachments, or
    // attachments small enough to ride inline.
    if (totalAttachmentBytes <= INLINE_ATTACHMENT_LIMIT) {
      const sent = await graphJson<{ error?: { message?: string } }>(token, "POST", `${userPath}/sendMail`, {
        message: {
          ...message,
          ...(attachments.length
            ? {
                attachments: attachments.map((a) => ({
                  "@odata.type": "#microsoft.graph.fileAttachment",
                  name: a.filename,
                  contentType: a.mimeType,
                  contentBytes: a.contentBase64,
                })),
              }
            : {}),
        },
        saveToSentItems: true,
      });
      if (sent.status >= 400) {
        refuseOn4xx(sent.status, sent.body.error?.message ?? `HTTP ${sent.status}`, "send");
      }
      return { provider: "graph", providerMessageId: internetMessageId };
    }

    // PR-i (Session 19), the large-attachment path (3–8MB — the 8MB ceiling
    // was enforced upstream): draft message → upload session per large file
    // → send. Needs Mail.ReadWrite (GO-LIVE console step); a refusal
    // surfaces as a visible failed state, never a silent drop.
    const draft = await graphJson<{ id?: string; error?: { message?: string } }>(
      token,
      "POST",
      `${userPath}/messages`,
      message
    );
    if (draft.status >= 400 || !draft.body.id) {
      refuseOn4xx(draft.status, draft.body.error?.message ?? `HTTP ${draft.status}`, "draft creation (large attachment path — Mail.ReadWrite consent required)");
    }
    const messageId = draft.body.id as string;

    for (const att of attachments) {
      const bytes = Buffer.from(att.contentBase64, "base64");
      if (bytes.length <= INLINE_ATTACHMENT_LIMIT) {
        const added = await graphJson<{ error?: { message?: string } }>(
          token,
          "POST",
          `${userPath}/messages/${encodeURIComponent(messageId)}/attachments`,
          {
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: att.filename,
            contentType: att.mimeType,
            contentBytes: att.contentBase64,
          }
        );
        if (added.status >= 400) {
          refuseOn4xx(added.status, added.body.error?.message ?? `HTTP ${added.status}`, "attachment add");
        }
        continue;
      }

      const session = await graphJson<{ uploadUrl?: string; error?: { message?: string } }>(
        token,
        "POST",
        `${userPath}/messages/${encodeURIComponent(messageId)}/attachments/createUploadSession`,
        {
          AttachmentItem: { attachmentType: "file", name: att.filename, size: bytes.length },
        }
      );
      if (session.status >= 400 || !session.body.uploadUrl) {
        refuseOn4xx(session.status, session.body.error?.message ?? `HTTP ${session.status}`, "upload session");
      }
      const uploadUrl = session.body.uploadUrl as string;
      for (let offset = 0; offset < bytes.length; offset += UPLOAD_CHUNK_BYTES) {
        const chunk = bytes.subarray(offset, Math.min(offset + UPLOAD_CHUNK_BYTES, bytes.length));
        const put = await fetch(uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Length": String(chunk.length),
            "Content-Range": `bytes ${offset}-${offset + chunk.length - 1}/${bytes.length}`,
          },
          body: new Uint8Array(chunk),
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        });
        if (put.status >= 400) {
          const detail = await put.text().catch(() => `HTTP ${put.status}`);
          refuseOn4xx(put.status, detail, "attachment upload");
        }
      }
    }

    const sent = await graphJson<{ error?: { message?: string } }>(
      token,
      "POST",
      `${userPath}/messages/${encodeURIComponent(messageId)}/send`
    );
    if (sent.status >= 400) {
      refuseOn4xx(sent.status, sent.body.error?.message ?? `HTTP ${sent.status}`, "send");
    }
    return { provider: "graph", providerMessageId: internetMessageId };
  };
}
