import "server-only";
import {
  createGraphEmailSender,
  createServiceClient,
  createWhatsAppSender,
  dispatchApprovedCommunications,
  type DispatchReport,
  type OutboundProviders,
} from "@rooshni/db";

/**
 * The web app's outbound carriers, wired from env (Session 10). Tenant comms
 * only: email rides Microsoft Graph as the firm, WhatsApp rides the Cloud
 * API. Platform mail rides Resend in platform-mail.ts and the two pipes
 * never mix (decision 87).
 *
 * An unconfigured carrier is simply absent — the dispatcher leaves those
 * rows approved and says so in its report; nothing fails silently and
 * nothing is carried without credentials.
 */
export function outboundProviders(): OutboundProviders {
  return {
    sendEmail: createGraphEmailSender() ?? undefined,
    sendWhatsApp: createWhatsAppSender() ?? undefined,
  };
}

/**
 * Best-effort inline dispatch of ONE just-stamped communication, so an
 * approval in the inbox becomes an arrival in seconds rather than a cron
 * cadence later. Quiet hours still hold it; any error leaves the row
 * approved for the tick sweep to retry — the approval itself never fails on
 * a carriage problem.
 */
export async function dispatchAfterApproval(communicationId: string): Promise<DispatchReport | null> {
  try {
    const db = createServiceClient();
    return await dispatchApprovedCommunications(db, {
      providers: outboundProviders(),
      onlyCommunicationId: communicationId,
    });
  } catch (err) {
    console.error(`inline dispatch of ${communicationId} failed (the tick will retry):`, err);
    return null;
  }
}
