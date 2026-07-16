import type { Metadata } from "next";
import { createServiceClient, getSignupByResumeToken } from "@rooshni/db";

import { SignupWizard, type ResumedSignup } from "./signup-wizard";

export const dynamic = "force-dynamic";

// Public surface — carries the platform name BARAKAH (founder ruling,
// 17 July 2026, amending decision 25's no-name rule for the signup pair,
// success page and reminder mail only; the holding page stays nameless and
// internal/repo names are unchanged).
export const metadata: Metadata = {
  title: "Barakah — set up your firm",
  description: "Two steps: your details, then your plan. Light starts work the moment payment clears.",
};

/**
 * Signup, outside the shell (decision 79): step 1 holds the details — the
 * website URL costs nothing to hold — and step 2 is the plan card into
 * Stripe Checkout. The crawl fires ONLY on payment.succeeded (decision 80);
 * nothing here spends a token.
 *
 * ?resume=<token> is the retry door from reminder emails: a pre-active
 * signup lands back on step 2 with their details intact (DoD ②).
 */
export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ resume?: string }>;
}) {
  const { resume } = await searchParams;

  let resumed: ResumedSignup | null = null;
  if (resume) {
    try {
      const record = await getSignupByResumeToken(createServiceClient(), resume);
      if (record) {
        resumed = {
          accountId: record.accountId,
          resumeToken: record.resumeToken,
          email: record.email,
          businessName: record.businessName,
        };
      }
    } catch {
      // An invalid or stale token simply starts a fresh signup — the link
      // must never error at a person who is trying to pay.
    }
  }

  return <SignupWizard resumed={resumed} />;
}
