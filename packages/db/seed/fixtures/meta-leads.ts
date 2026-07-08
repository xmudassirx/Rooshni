/**
 * Two test leads shaped exactly as Meta Lead Ads delivers them.
 *
 * `webhook` is the POST body Meta sends to the leadgen webhook (the ping —
 * it carries ids only, never field data). `lead` is what the Graph API
 * returns when the handler fetches the leadgen_id. When the real webhook is
 * built (build-order step 6) it will ingest this exact shape; the seed
 * ingests these fixtures through the same code path shape today.
 *
 * Graph API v25.0+ only (older versions deprecate October 2026).
 */

export interface MetaLeadgenWebhook {
  object: "page";
  entry: Array<{
    id: string;
    time: number;
    changes: Array<{
      field: "leadgen";
      value: {
        ad_id: string;
        form_id: string;
        leadgen_id: string;
        created_time: number;
        page_id: string;
        adgroup_id: string;
      };
    }>;
  }>;
}

export interface MetaLeadDetail {
  id: string;
  created_time: string;
  ad_id: string;
  adset_id: string;
  campaign_id: string;
  form_id: string;
  is_organic: boolean;
  field_data: Array<{ name: string; values: string[] }>;
}

export interface MetaLeadFixture {
  webhook: MetaLeadgenWebhook;
  lead: MetaLeadDetail;
}

const PAGE_ID = "112233445566778";
const FORM_ID = "1234567890123456";
const CAMPAIGN_ID = "120210000000000001";
const ADSET_ID = "120210000000000002";
const AD_ID = "120210000000000003";

function fixture(
  leadgenId: string,
  createdTime: string,
  fullName: string,
  phone: string,
  email: string
): MetaLeadFixture {
  const epoch = Math.floor(new Date(createdTime).getTime() / 1000);
  return {
    webhook: {
      object: "page",
      entry: [
        {
          id: PAGE_ID,
          time: epoch,
          changes: [
            {
              field: "leadgen",
              value: {
                ad_id: AD_ID,
                form_id: FORM_ID,
                leadgen_id: leadgenId,
                created_time: epoch,
                page_id: PAGE_ID,
                adgroup_id: AD_ID,
              },
            },
          ],
        },
      ],
    },
    lead: {
      id: leadgenId,
      created_time: createdTime,
      ad_id: AD_ID,
      adset_id: ADSET_ID,
      campaign_id: CAMPAIGN_ID,
      form_id: FORM_ID,
      is_organic: false,
      field_data: [
        { name: "full_name", values: [fullName] },
        { name: "phone_number", values: [phone] },
        { name: "email", values: [email] },
      ],
    },
  };
}

export const metaLeadFixtures: MetaLeadFixture[] = [
  fixture(
    "444400000000000001",
    "2026-07-08T09:15:00+0000",
    "Mudassir Test",
    "00447496166555",
    "xmudassirx@gmail.com"
  ),
  fixture(
    "444400000000000002",
    "2026-07-08T10:40:00+0000",
    "BarakahX Mudz",
    "00923065443244",
    "mudassir@barakahx.com"
  ),
];
