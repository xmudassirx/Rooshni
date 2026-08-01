/**
 * The tenant-mailbox connector boundary (Session 20). Email carriage and
 * inbound reading go through these provider-neutral shapes — Microsoft Graph
 * (Session 16) and the Gmail API (Session 20) both implement them, and
 * nothing above the boundary knows which provider is underneath
 * (external-integrations: no provider-specific types leak upward).
 *
 * The vocabulary is RFC 5322, not any provider's: the stable identity of a
 * mail is its internet message id, and reply threading reads the
 * In-Reply-To/References header ids — both providers surface them.
 */

/** One inbound mail as a poll reads it (Session 16, PR-A shape). */
export interface InboundMailMessage {
  id: string;
  internetMessageId: string | null;
  receivedDateTime: string;
  subject: string | null;
  fromAddress: string | null;
  fromName: string | null;
  /** Plain-text body. */
  bodyText: string;
  /** RFC 5322 message ids this mail replies into (In-Reply-To + References). */
  referenceIds: string[];
}

export interface MailboxInboundReader {
  mailbox: string;
  /** New inbox mail strictly after the cursor, oldest first, capped. */
  listNewMessages: (sinceIso: string, top?: number) => Promise<
    Array<{
      id: string;
      internetMessageId: string | null;
      receivedDateTime: string;
      subject: string | null;
      fromAddress: string | null;
      fromName: string | null;
    }>
  >;
  /** Full detail for one message: text body + reply headers. */
  getMessage: (id: string) => Promise<InboundMailMessage>;
}

/** Extract every <rfc-id> from In-Reply-To/References header values. */
export function parseReferenceIds(headerValues: string[]): string[] {
  const ids = new Set<string>();
  for (const value of headerValues) {
    for (const match of value.matchAll(/<[^<>\s]+>/g)) ids.add(match[0]);
  }
  return [...ids];
}
