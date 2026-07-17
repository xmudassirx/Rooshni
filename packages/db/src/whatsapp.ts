import { ProviderRejectedError, type SendResult, type WaTemplateRef } from "./send";

/**
 * WhatsApp Business Cloud API — the firm's WhatsApp carrier (Session 10).
 *
 * Version PINNED (external-integrations: version strings live in config;
 * Meta Graph v25.0+ only — older versions deprecate October 2026). Shared by
 * the WhatsApp sender and the Lead Ads retrieval in meta.ts.
 *
 * Session-window law is enforced where enforcement lives — the readiness
 * pre-flight (0021): a free-form message outside the 24h customer-service
 * window cannot even be APPROVED. This adapter carries what the stamp
 * allowed: a template message ({name, language, components} from the row's
 * attributes.wa_template) any time, free-form text inside the window.
 */

export const META_GRAPH_API_VERSION = "v25.0";
export const META_GRAPH_API_BASE = `https://graph.facebook.com/${META_GRAPH_API_VERSION}`;
const TIMEOUT_MS = 15_000;

interface WhatsAppEnv {
  accessToken: string;
  phoneNumberId: string;
}

export function readWhatsAppEnv(env: NodeJS.ProcessEnv = process.env): WhatsAppEnv | null {
  const accessToken = env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId) return null;
  return { accessToken, phoneNumberId };
}

/** Builds the WhatsApp carrier, or null when unconfigured (the dispatcher
 * then leaves WhatsApp rows approved and says so in its report). */
export function createWhatsAppSender(
  env: NodeJS.ProcessEnv = process.env
): ((input: { to: string; body: string; template: WaTemplateRef | null }) => Promise<SendResult>) | null {
  const waEnv = readWhatsAppEnv(env);
  if (!waEnv) return null;

  return async (input) => {
    const payload = input.template
      ? {
          messaging_product: "whatsapp",
          to: input.to,
          type: "template",
          template: {
            name: input.template.name,
            language: { code: input.template.language },
            ...(input.template.components ? { components: input.template.components } : {}),
          },
        }
      : {
          messaging_product: "whatsapp",
          to: input.to,
          type: "text",
          text: { body: input.body },
        };

    const response = await fetch(`${META_GRAPH_API_BASE}/${waEnv.phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${waEnv.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as {
      messages?: Array<{ id?: string }>;
      error?: { message?: string };
    };
    if (!response.ok) {
      const detail = body.error?.message ?? `HTTP ${response.status}`;
      if (response.status >= 400 && response.status < 500) {
        throw new ProviderRejectedError(`WhatsApp refused the message: ${detail}`, "whatsapp");
      }
      throw new Error(`WhatsApp send failed: ${detail}`);
    }
    return {
      provider: "whatsapp",
      providerMessageId: body.messages?.[0]?.id ?? null,
    };
  };
}
