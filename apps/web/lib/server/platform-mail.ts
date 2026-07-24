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
 * Session 11 — the nurture sequence per the v3 template doc: 24h resume
 * reminder (shipped in Session 9) · day-3 product story (the two-hours-a-day
 * problem, the stamp loop) · day-7 founder's note with the walkthrough
 * offer · then silence. Honest-claims law: capability claims only, no
 * invented social proof, until real pilot numbers exist. Unsubscribe on all
 * three — the link stops nurture mail immediately; the 30-day retention
 * clock (and its deletion promise) is unaffected.
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
  if (kind === "3d") {
    // The day-3 product story — the 2-hours-a-day problem and the stamp loop.
    return {
      subject: `${businessName} — the two hours a day your inbox is taking`,
      heading: "The problem isn't the enquiries. It's the two hours they cost.",
      body:
        "Most firms we talk to spend a couple of hours every day on the same loop: " +
        "a lead arrives, someone copies it into a spreadsheet, someone drafts the same " +
        "first reply for the tenth time, someone forgets the follow-up.\n\n" +
        "Barakah runs that loop differently. Light — the AI that works inside it — " +
        "captures the lead, opens the enquiry, and drafts the reply. Then it stops. " +
        "Nothing reaches a client until you stamp it: the database itself refuses an " +
        "unapproved send, and every act lands on an append-only record you can read " +
        "line by line. You keep the judgment; Light does the typing.\n\n" +
        "Your signup is still saved — the link below picks up at the plan page.",
    };
  }
  // Day 7 — the founder's note. DRAFTED BY THE BUILDER for founder review at
  // the session close; re-issue with the founder's own words if preferred.
  return {
    subject: `${businessName} — a note from the founder`,
    heading: "A week on — an honest note, then we go quiet.",
    body:
      "I'm Mudassir — I built Barakah, and I run its first pilot inside a real " +
      "immigration firm, on real enquiries, every day.\n\n" +
      "If the timing wasn't right, no harm — we hold your details for 30 days from " +
      "signup, then delete them entirely, and this is the last email either way.\n\n" +
      "But if the idea landed — an AI that does the work while every client-facing " +
      "act still waits for your stamp — I'd rather show you than describe it. Every " +
      "pilot includes a walkthrough with me personally: your setup, your cases, your " +
      "questions, a person not a video. Finish signing up below and the walkthrough " +
      "booking is one of the first things you'll see.",
  };
}

/**
 * Send a nurture mail (24h resume / day-3 story / day-7 founder's note, then
 * silence — the ruled schedule). Throws on failure: the sweep records the
 * error and retries next tick; the sent-stamp only lands after a successful
 * send. Every mail carries the unsubscribe link (Session 11).
 */
export async function sendSignupReminder(
  kind: ReminderKind,
  target: ReminderTarget,
  origin: string
): Promise<void> {
  const apiKey = requireEnv("RESEND_API_KEY");
  const from = requireEnv("PLATFORM_MAIL_FROM");
  const resumeUrl = `${origin}/signup?resume=${target.resumeToken}`;
  const unsubscribeUrl = `${origin}/api/signup/unsubscribe?token=${target.resumeToken}`;
  const copy = reminderCopy(kind, target.businessName);

  const signoff = kind === "7d" ? "— Mudassir, founder · Barakah" : "— Barakah";

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
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
      },
      text:
        `${copy.heading}\n\n${copy.body}\n\n` +
        `Finish signing up: ${resumeUrl}\n\n` +
        `${signoff}\n` +
        `You're receiving this because ${target.email} started a Barakah signup for ` +
        `${target.businessName}. We send at most three of these, then stop.\n` +
        `No more of these: ${unsubscribeUrl}`,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Resend refused the ${kind} reminder (${response.status}): ${detail}`);
  }
}
