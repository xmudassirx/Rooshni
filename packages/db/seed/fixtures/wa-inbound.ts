/**
 * WhatsApp Cloud API inbound-message webhook fixtures (Session 16, PR-A).
 *
 * Provider-exact (external-integrations: the seeded payload matches Meta's
 * documented format precisely — Graph API v25.0, webhooks for
 * whatsapp_business_account, field "messages"). The contract the
 * /api/whatsapp/webhook handler and the check-local smokes verify against;
 * the live wiring (webhook registration in the Meta app console) is the
 * founder's console act.
 *
 * Shape source: Meta "WhatsApp Cloud API — Webhooks payload examples",
 * text-message delivery. The wamid is the idempotency key; timestamp is
 * unix seconds as a STRING; `from` is digits with country code, no plus.
 */

export interface WaInboundFixture {
  object: string;
  entry: Array<{
    id: string;
    changes: Array<{
      value: {
        messaging_product: string;
        metadata: { display_phone_number: string; phone_number_id: string };
        contacts: Array<{ profile: { name: string }; wa_id: string }>;
        messages: Array<{
          from: string;
          id: string;
          timestamp: string;
          type: string;
          text?: { body: string };
        }>;
      };
      field: string;
    }>;
  }>;
}

/** The test WABA's ids (WABA 270272332844358 — decision 119's verified test
 * account); the phone_number_id below is a fixture stand-in the smokes bind
 * via settings.whatsapp.phone_number_id. */
export const WA_FIXTURE_PHONE_NUMBER_ID = "111000222000333";

export const waInboundTextMessage = (overrides: {
  wamid?: string;
  from?: string;
  body?: string;
  timestamp?: string;
  profileName?: string;
} = {}): WaInboundFixture => ({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "270272332844358",
      changes: [
        {
          value: {
            messaging_product: "whatsapp",
            metadata: {
              display_phone_number: "15550000000",
              phone_number_id: WA_FIXTURE_PHONE_NUMBER_ID,
            },
            contacts: [
              {
                profile: { name: overrides.profileName ?? "Test Person" },
                wa_id: overrides.from ?? "447700900123",
              },
            ],
            messages: [
              {
                from: overrides.from ?? "447700900123",
                id: overrides.wamid ?? "wamid.HBgLNDQ3NzAwOTAwMTIzFQIAEhgUM0E5RkYxQzYzRkQ2QUE3RkYxRkYA",
                timestamp: overrides.timestamp ?? "1754006400",
                type: "text",
                text: { body: overrides.body ?? "Hello — I had a question about my enquiry." },
              },
            ],
          },
          field: "messages",
        },
      ],
    },
  ],
});

/** A status (delivery receipt) delivery — the shape the handler must
 * acknowledge and walk past (decision 103's future tightening). */
export const waStatusDelivery = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "270272332844358",
      changes: [
        {
          value: {
            messaging_product: "whatsapp",
            metadata: {
              display_phone_number: "15550000000",
              phone_number_id: WA_FIXTURE_PHONE_NUMBER_ID,
            },
            statuses: [
              {
                id: "wamid.HBgLNDQ3NzAwOTAwMTIzFQIAEhgUM0E5RkYxQzYzRkQ2QUE3RkYxRkYA",
                status: "delivered",
                timestamp: "1754006500",
                recipient_id: "447700900123",
              },
            ],
          },
          field: "messages",
        },
      ],
    },
  ],
};
