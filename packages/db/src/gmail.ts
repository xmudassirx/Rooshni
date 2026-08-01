import { randomUUID } from "node:crypto";
import { ProviderRejectedError, type SendResult } from "./send";
import { parseReferenceIds, type InboundMailMessage, type MailboxInboundReader } from "./mailbox";

/**
 * Gmail API mail — Google Workspace as an ALTERNATIVE tenant-mail provider
 * (Session 20), selected per business (businesses.settings.mail_provider);
 * X Law stays on Microsoft Graph, untouched. Tenant comms only — platform
 * mail rides Resend and the two pipes never mix (decision 87).
 *
 * Auth is the mailbox owner's OAuth refresh token (Workspace consent config
 * — the founder's console steps, Lane C credentials protocol): the token is
 * minted against GMAIL_CLIENT_ID/SECRET and acts as GMAIL_SENDER_ADDRESS.
 * Least privilege: gmail.send + gmail.readonly scopes only.
 *
 * Carriage self-mints the RFC 5322 Message-ID (the graph.ts pattern) so the
 * sent row carries the id replies will reference; the whole message rides
 * ONE upload-type send (message/rfc822), which carries attachments well past
 * the ruled 8MB ceiling — no split path needed. External calls fail:
 * explicit timeouts; a Gmail 4xx becomes a ProviderRejectedError (visible
 * failed state) while 5xx/network stays transient (the row remains approved;
 * the next tick retries). Raw fetch is the house pattern (decision 132's
 * rider) — no googleapis SDK.
 */

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const GMAIL_UPLOAD_SEND = "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 60_000;

interface GmailEnv {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  senderAddress: string;
}

export function readGmailEnv(env: NodeJS.ProcessEnv = process.env): GmailEnv | null {
  const clientId = env.GMAIL_CLIENT_ID;
  const clientSecret = env.GMAIL_CLIENT_SECRET;
  const refreshToken = env.GMAIL_REFRESH_TOKEN;
  const senderAddress = env.GMAIL_SENDER_ADDRESS;
  if (!clientId || !clientSecret || !refreshToken || !senderAddress) return null;
  return { clientId, clientSecret, refreshToken, senderAddress: senderAddress.toLowerCase() };
}

let tokenCache: { token: string; expiresAt: number } | null = null;

async function getGmailToken(env: GmailEnv): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.clientId,
      client_secret: env.clientSecret,
      refresh_token: env.refreshToken,
      grant_type: "refresh_token",
    }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await response.json()) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!response.ok || !body.access_token) {
    throw new Error(
      `Gmail token request failed (${response.status}): ${body.error_description ?? body.error ?? "unknown error"}`
    );
  }
  tokenCache = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return body.access_token;
}

interface GmailAttachment {
  filename: string;
  mimeType: string;
  contentBase64: string;
}

const wrap76 = (b64: string) => b64.replace(/(.{76})/g, "$1\r\n");

/** RFC 2047 B-encoding for any header value that leaves ASCII. */
const encodeHeaderWord = (value: string) =>
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;

/**
 * Build the RFC 822 document Gmail will carry, EXPORTED PURE so the harness
 * proves the shape without a credential: headers (self-minted Message-ID
 * included), the body as one part, attachments as base64 multipart/mixed
 * parts.
 */
export function buildGmailMime(input: {
  from: string;
  to: string;
  subject: string | null;
  body: string;
  bodyFormat: string;
  messageId: string;
  attachments?: GmailAttachment[];
}): string {
  const bodyContentType = input.bodyFormat === "html" ? "text/html" : "text/plain";
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${encodeHeaderWord(input.subject ?? "")}`,
    `Message-ID: ${input.messageId}`,
    "MIME-Version: 1.0",
  ];
  const bodyPart =
    `Content-Type: ${bodyContentType}; charset=UTF-8\r\n` +
    `Content-Transfer-Encoding: base64\r\n\r\n` +
    wrap76(Buffer.from(input.body, "utf8").toString("base64"));

  const attachments = input.attachments ?? [];
  if (attachments.length === 0) {
    return `${headers.join("\r\n")}\r\n${bodyPart}`;
  }

  const boundary = `=_rooshni_${randomUUID()}`;
  const parts = [
    bodyPart,
    ...attachments.map(
      (a) =>
        `Content-Type: ${a.mimeType}; name="${a.filename.replace(/"/g, "")}"\r\n` +
        `Content-Disposition: attachment; filename="${a.filename.replace(/"/g, "")}"\r\n` +
        `Content-Transfer-Encoding: base64\r\n\r\n` +
        wrap76(a.contentBase64)
    ),
  ];
  return (
    `${headers.join("\r\n")}\r\n` +
    `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n` +
    parts.map((p) => `--${boundary}\r\n${p}`).join("\r\n") +
    `\r\n--${boundary}--\r\n`
  );
}

/** Builds the email carrier, or null when Gmail is not configured (the
 * dispatcher then leaves gmail-selected rows approved and says so). */
export function createGmailEmailSender(
  env: NodeJS.ProcessEnv = process.env
): ((input: {
  to: string;
  subject: string | null;
  body: string;
  bodyFormat: string;
  attachments?: GmailAttachment[];
}) => Promise<SendResult>) | null {
  const gmailEnv = readGmailEnv(env);
  if (!gmailEnv) return null;

  return async (input) => {
    const token = await getGmailToken(gmailEnv);
    const senderDomain = gmailEnv.senderAddress.split("@")[1] ?? "barakah.invalid";
    const internetMessageId = `<${randomUUID()}@${senderDomain}>`;
    const mime = buildGmailMime({
      from: gmailEnv.senderAddress,
      to: input.to,
      subject: input.subject,
      body: input.body,
      bodyFormat: input.bodyFormat,
      messageId: internetMessageId,
      attachments: input.attachments,
    });

    const response = await fetch(GMAIL_UPLOAD_SEND, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "message/rfc822",
      },
      body: mime,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    const text = await response.text();
    const body = (text ? JSON.parse(text) : {}) as { id?: string; error?: { message?: string } };
    if (response.status >= 400) {
      const detail = body.error?.message ?? `HTTP ${response.status}`;
      if (response.status < 500) throw new ProviderRejectedError(`Gmail refused the send: ${detail}`, "gmail");
      throw new Error(`Gmail send failed: ${detail}`);
    }
    return { provider: "gmail", providerMessageId: internetMessageId };
  };
}

/* ---------------------------------------------------------------------------
 * Inbound: the Gmail sibling of the Graph reader — same MailboxInboundReader
 * boundary, so the shared poll in inbound.ts consumes either.
 * ------------------------------------------------------------------------- */

interface GmailHeadersHolder {
  payload?: { headers?: Array<{ name: string; value: string }> };
}

function headerValue(msg: GmailHeadersHolder, name: string): string | null {
  const h = (msg.payload?.headers ?? []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
}

/** "Display Name <address>" → both halves; bare addresses pass through. */
function parseFromHeader(value: string | null): { address: string | null; name: string | null } {
  if (!value) return { address: null, name: null };
  const match = value.match(/^\s*(?:"?([^"<]*)"?\s*)?<([^<>\s]+@[^<>\s]+)>\s*$/);
  if (match) {
    const name = match[1]?.trim() || null;
    return { address: match[2]!.toLowerCase(), name };
  }
  const bare = value.trim();
  return /^[^\s@]+@[^\s@]+$/.test(bare)
    ? { address: bare.toLowerCase(), name: null }
    : { address: null, name: bare || null };
}

const fromBase64Url = (data: string) => Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

interface GmailPayloadPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPayloadPart[];
}

/** Depth-first hunt for a text/plain part; text/html (tags stripped) is the
 * honest fallback for HTML-only mail — the words, never the markup. */
export function extractGmailBodyText(payload: GmailPayloadPart | undefined): string {
  if (!payload) return "";
  const findPart = (part: GmailPayloadPart, mime: string): string | null => {
    if (part.mimeType === mime && part.body?.data) return fromBase64Url(part.body.data);
    for (const child of part.parts ?? []) {
      const found = findPart(child, mime);
      if (found !== null) return found;
    }
    return null;
  };
  const plain = findPart(payload, "text/plain");
  if (plain !== null) return plain;
  const html = findPart(payload, "text/html");
  if (html !== null) {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();
  }
  return "";
}

/**
 * Builds the inbound mailbox reader, or null when Gmail is not configured
 * (the poll then reports itself absent — a visible no-op, never a silent
 * one). A consent/scope gap surfaces as Google's 403 in the poll report
 * (fail closed; the founder's console steps lift it — Lane C credentials
 * protocol, the Mail.Read precedent).
 */
export function createGmailInboundReader(
  env: NodeJS.ProcessEnv = process.env
): MailboxInboundReader | null {
  const gmailEnv = readGmailEnv(env);
  if (!gmailEnv) return null;
  const mailbox = gmailEnv.senderAddress;

  const gmailJson = async <T>(token: string, path: string): Promise<T> => {
    const response = await fetch(`${GMAIL_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    const body = (text ? JSON.parse(text) : {}) as T & { error?: { code?: number; message?: string } };
    if (response.status >= 400) {
      throw new Error(`Gmail request failed (${response.status}): ${body.error?.message ?? "unknown error"}`);
    }
    return body;
  };

  const listNewMessages = async (sinceIso: string, top = 25) => {
    const token = await getGmailToken(gmailEnv);
    // Gmail's after: operator is second-granular; the strictly-after filter
    // below (millisecond ISO compare) keeps the cursor message itself out.
    const afterEpoch = Math.floor(Date.parse(sinceIso) / 1000);
    const query = encodeURIComponent(`in:inbox after:${afterEpoch}`);
    const list = await gmailJson<{ messages?: Array<{ id: string }> }>(
      token,
      `/messages?q=${query}&maxResults=${top}`
    );
    const heads: Array<{
      id: string;
      internetMessageId: string | null;
      receivedDateTime: string;
      subject: string | null;
      fromAddress: string | null;
      fromName: string | null;
    }> = [];
    for (const m of list.messages ?? []) {
      const meta = await gmailJson<
        GmailHeadersHolder & { id: string; internalDate?: string }
      >(
        token,
        `/messages/${encodeURIComponent(m.id)}?format=metadata` +
          `&metadataHeaders=Message-ID&metadataHeaders=Subject&metadataHeaders=From`
      );
      const receivedDateTime = new Date(Number(meta.internalDate ?? 0)).toISOString();
      if (receivedDateTime <= sinceIso) continue;
      const from = parseFromHeader(headerValue(meta, "From"));
      heads.push({
        id: meta.id,
        internetMessageId: headerValue(meta, "Message-ID"),
        receivedDateTime,
        subject: headerValue(meta, "Subject"),
        fromAddress: from.address,
        fromName: from.name,
      });
    }
    // Gmail lists newest first; the poll wants oldest first.
    heads.sort((a, b) => a.receivedDateTime.localeCompare(b.receivedDateTime));
    return heads;
  };

  const getMessage = async (id: string): Promise<InboundMailMessage> => {
    const token = await getGmailToken(gmailEnv);
    const full = await gmailJson<
      GmailHeadersHolder & { id: string; internalDate?: string; payload?: GmailPayloadPart }
    >(token, `/messages/${encodeURIComponent(id)}?format=full`);
    const from = parseFromHeader(headerValue(full, "From"));
    const replyHeaders = [headerValue(full, "In-Reply-To"), headerValue(full, "References")].filter(
      (v): v is string => v !== null
    );
    return {
      id: full.id,
      internetMessageId: headerValue(full, "Message-ID"),
      receivedDateTime: new Date(Number(full.internalDate ?? Date.now())).toISOString(),
      subject: headerValue(full, "Subject"),
      fromAddress: from.address,
      fromName: from.name,
      bodyText: extractGmailBodyText(full.payload),
      referenceIds: parseReferenceIds(replyHeaders),
    };
  };

  return { mailbox, listNewMessages, getMessage };
}
