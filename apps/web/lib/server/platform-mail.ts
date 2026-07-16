import "server-only";
import { requireEnv } from "@rooshni/config";
import type { ReminderKind, ReminderTarget } from "@rooshni/db";

/**
 * Platform mail (Resend) — founder-ruled 17 July 2026: platform mail and
 * tenant comms are SEPARATE PIPES, permanently. Graph sends as the firm and
 * must never carry platform email; this module sends as Barakah and must
 * never carry a tenant's message. Nothing here touches the communications
 * table or its approval pipeline — these mails go to people who are not yet
 * customers of any tenant.
 *
 * Public-surface naming: the platform is BARAKAH (the naming ruling);
 * production sending domain barakahx.com is a GO-LIVE item.
 */

const RESEND_API_URL = "https://api.resend.com/emails";

interface ReminderCopy {
  subject: string;
  heading: string;
  body: string;
}

function reminderCopy(kind: ReminderKind, businessName: string): ReminderCopy {
  if (kind === "24h") {
    return {
      subject: `${businessName} — your Barakah setup is one step from done`,
      heading: "Your details are held. One step remains.",
      body:
        "You gave us your details yesterday but the payment step wasn't finished. " +
        "Your signup is saved exactly where you left it — the link below takes you " +
        "straight back to the plan page.",
    };
  }
  return {
    subject: `${businessName} — shall we hold your place?`,
    heading: "A week on — your signup is still waiting.",
    body:
      "This is our last reminder, so it's an honest one: we hold your details for " +
      "30 days from signup, then delete them entirely. If the timing wasn't right, " +
      "do nothing and your record quietly disappears. If you're ready, the link " +
      "below picks up exactly where you left off.",
  };
}

/**
 * Send a pre-active reminder (24h / 7d, then silence — the ruled schedule).
 * Throws on failure: the sweep records the error and retries next tick; the
 * sent-stamp only lands after a successful send.
 */
export async function sendSignupReminder(
  kind: ReminderKind,
  target: ReminderTarget,
  origin: string
): Promise<void> {
  const apiKey = requireEnv("RESEND_API_KEY");
  const from = requireEnv("PLATFORM_MAIL_FROM");
  const resumeUrl = `${origin}/signup?resume=${target.resumeToken}`;
  const copy = reminderCopy(kind, target.businessName);

  const response = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [target.email],
      subject: copy.subject,
      text:
        `${copy.heading}\n\n${copy.body}\n\n` +
        `Finish signing up: ${resumeUrl}\n\n` +
        `— Barakah\n` +
        `You're receiving this because ${target.email} started a Barakah signup for ` +
        `${target.businessName}. We send at most two of these, then stop.`,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Resend refused the ${kind} reminder (${response.status}): ${detail}`);
  }
}
