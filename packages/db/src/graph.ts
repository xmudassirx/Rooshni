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
