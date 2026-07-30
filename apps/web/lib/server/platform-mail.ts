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
 * Founder copy chore (30 Jul 2026): the day-7 note is the founder's own
 * words, approved verbatim; day-3's voice aligned with it (no new claims).
 * The GO-LIVE nurture-copy line is ticked on the founder's order.
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

function reminderCopy(kind: ReminderKind, businessName: string, resumeUrl: string): ReminderCopy {
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
    // Voice aligned with the founder's day-7 note (chore, 30 Jul 2026): the
    // "most firms we talk to" soft claim is gone — direct address, no new
    // claims; the mechanics description already matches his words.
    return {
      subject: `${businessName} — the two hours a day your inbox is taking`,
      heading: "The problem isn't the enquiries. It's the two hours they cost.",
      body:
        "You'll know the loop: a lead arrives, someone copies it into a spreadsheet, " +
        "someone drafts the same first reply for the tenth time, someone forgets the " +
        "follow-up — and hours slip away every day to work that never changes.\n\n" +
        "Barakah runs that loop differently. Light — the AI that works inside it — " +
        "captures the lead, opens the enquiry, and drafts the reply. Then it stops. " +
        "Nothing reaches a client until you stamp it: the database itself refuses an " +
        "unapproved send, and every act lands on an append-only record you can read " +
        "line by line. You keep the judgment; Light does the typing.\n\n" +
        "Your signup is still saved — the link below picks up at the plan page.",
    };
  }
  // Day 7 — the founder's note, HIS OWN WORDS, approved verbatim (chore,
  // 30 Jul 2026). Paragraph breaks are presentational only; the words are
  // untouched. JUDGMENT: the approved copy's "[link]" placeholder is wired
  // to the signup resume link — the only booking door that exists today
  // (the walkthrough booking lives behind signup until the booking-link
  // session); swap to a real booking URL on the founder's word.
  return {
    subject: `${businessName} — a note from the founder`,
    heading: "A note from the founder",
    body:
      "I'm Mudassir. I've run businesses myself — an immigration firm among them — " +
      "and I built Barakah because I kept losing hours every day to the same work: " +
      "chasing enquiries, drafting the same follow-ups, worrying about what slipped.\n\n" +
      "Barakah works alongside you around the clock: it watches your enquiries, " +
      "drafts the responses, and queues everything for your approval — nothing is " +
      "ever sent without your stamp. You tell it how you work once; it handles the " +
      "routine; you stay in charge.\n\n" +
      `If you'd like, I'll walk you through it personally — book a time here: ${resumeUrl}.`,
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
  const copy = reminderCopy(kind, target.businessName, resumeUrl);

  const signoff = kind === "7d" ? "— Mudassir, founder of Barakah" : "— Barakah";

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
        // The 7d note carries its link inside the founder's own words — no
        // second copy of the same URL. Unsubscribe mechanics unchanged below.
        (kind === "7d" ? "" : `Finish signing up: ${resumeUrl}\n\n`) +
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
