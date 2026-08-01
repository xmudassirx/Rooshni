/**
 * The booking link (Session 19, founder pre-ruling PR-iv).
 *
 * businesses.settings.booking_url is the firm's own booking page (X Law
 * points it at its existing one). When set, the literal `[link]` token in a
 * CLIENT-FACING message body resolves to it at composition time — the stored
 * body carries the real URL, so WYSIWYS holds and the stamp approves exactly
 * what the client receives. When unset, no tenant `[link]` mechanism exists:
 * a body that still carries the token is refused loudly (the unresolved-
 * placeholder lane, decision 19's spirit), never sent literal.
 *
 * One door: Settings → General. The PLATFORM nurture [link] (signup resume,
 * the s10/s11 JUDGMENT in platform-mail.ts) is a separate pipe and is NOT
 * this — it stays as-is, per the ruling.
 */

export const BOOKING_LINK_TOKEN = "[link]";

/** The configured booking URL, or null. Only absolute http(s) URLs count —
 * anything else reads as unset (the honest state), never as a half-link. */
export function resolveBookingUrl(settings: Record<string, unknown> | null | undefined): string | null {
  const raw = settings?.booking_url;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return null;
  return trimmed;
}

/**
 * Replace every `[link]` in a client-facing body with the configured booking
 * URL. A body carrying the token with no URL configured throws — a visible
 * composition failure, never a literal "[link]" in a client's inbox.
 */
export function substituteBookingLink(body: string, bookingUrl: string | null): string {
  if (!body.includes(BOOKING_LINK_TOKEN)) return body;
  if (!bookingUrl) {
    throw new Error(
      "the body carries [link] but no booking URL is configured — set it in Settings → General or remove the placeholder"
    );
  }
  return body.split(BOOKING_LINK_TOKEN).join(bookingUrl);
}
