/**
 * Quiet hours — dispatch policy, Session 10.
 *
 * The signed design (master-mockup-v2, Settings → General) fixes the rule:
 * "No client sends 20:00–08:00. Stamped messages that hit quiet hours queue
 * and dispatch at 08:00 — the stamp is yours, the timing is policy."
 *
 * JUDGMENT: quiet hours are a WALL-CLOCK WINDOW in the business's timezone,
 * not a duration — law 11 (timeScale) governs durations; a clock window has
 * nothing to scale. Tests inject the clock instead. The provisional default
 * below is the mockup's regulated-firm default; per-business override lives
 * in businesses.settings.quiet_hours ({start,end} local "HH:MM", or null to
 * disable) — data, like every other policy.
 */

export interface QuietHours {
  /** Local wall-clock "HH:MM" at which sends stop. */
  start: string;
  /** Local wall-clock "HH:MM" at which held sends dispatch. */
  end: string;
}

/** The last-resort fallback for INSTALL-LESS businesses only (Session 26,
 * C5, founder-ruled): the unset-business default resolves from the installed
 * template's declared business_identity.defaults.quiet_hours — one source;
 * vertical content renders from the template, never product chrome. This
 * constant remains solely for a business with no template install. */
export const QUIET_HOURS_DEFAULT: QuietHours = { start: "20:00", end: "08:00" };

/** A declared {start, end} from template content, validated — null when the
 * declaration is absent or malformed (a bad declaration never disables the
 * hold; resolution falls through to the constant). */
export function declaredTemplateQuietHours(value: unknown): QuietHours | null {
  if (value && typeof value === "object") {
    const candidate = value as Partial<QuietHours>;
    if (isHHMM(candidate.start) && isHHMM(candidate.end)) {
      return { start: candidate.start!, end: candidate.end! };
    }
  }
  return null;
}

/** businesses.settings.quiet_hours: a firm-set window wins; undefined →
 * the installed template's declared default (C5, founder-ruled), else the
 * install-less constant; explicit null → disabled. */
export function resolveQuietHours(
  settings: Record<string, unknown> | null | undefined,
  templateDefault?: QuietHours | null
): QuietHours | null {
  const raw = settings?.quiet_hours;
  if (raw === null) return null;
  if (raw && typeof raw === "object") {
    const candidate = raw as Partial<QuietHours>;
    if (isHHMM(candidate.start) && isHHMM(candidate.end)) {
      return { start: candidate.start!, end: candidate.end! };
    }
  }
  return declaredTemplateQuietHours(templateDefault) ?? QUIET_HOURS_DEFAULT;
}

function isHHMM(value: unknown): value is string {
  return typeof value === "string" && /^\d{2}:\d{2}$/.test(value);
}

/*
 * Business hours — the defect-trio hotfix (2 Aug 2026, item 3). The firm
 * SETS its business hours (a simple daily send window, open→close, in the
 * business's timezone); the quiet-hours hold is that window's complement.
 * ONE SOURCE: businesses.settings.quiet_hours remains the stored truth the
 * hold has always read — the send window is a PRESENTATION of it, and the
 * two conversions below are exact inverses so the Settings editor, the
 * "sends [time]" display and the dispatch_at calculation can never disagree.
 */

/** A firm's daily send window, local wall-clock "HH:MM" — open is when held
 * sends dispatch (= quiet end), close is when sends stop (= quiet start). */
export interface SendWindow {
  open: string;
  close: string;
}

export function sendWindowFromQuietHours(quiet: QuietHours): SendWindow {
  return { open: quiet.end, close: quiet.start };
}

export function quietHoursFromSendWindow(window: SendWindow): QuietHours {
  return { start: window.close, end: window.open };
}

/** Is settings.quiet_hours a firm-set value (vs the honest default)? The
 * Settings surface says "default — not yet set by you" until this is true;
 * null (holds disabled, founder wiring) also counts as deliberately set. */
export function isQuietHoursSet(settings: Record<string, unknown> | null | undefined): boolean {
  const raw = settings?.quiet_hours;
  if (raw === null) return true;
  if (raw && typeof raw === "object") {
    const candidate = raw as Partial<QuietHours>;
    return isHHMM(candidate.start) && isHHMM(candidate.end);
  }
  return false;
}

/** The Settings display string for a send window — also the derived
 * settings.business_hours value the setter writes (single writer; the
 * structured window stays the one truth). */
export function describeSendWindow(window: SendWindow, timezone: string): string {
  return `${window.open}–${window.close} · ${timezone}`;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Minutes past local midnight for an instant, in an IANA timezone. */
export function minutesOfDayIn(timezone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

/**
 * If `at` falls inside quiet hours, the instant the window ends (the queued
 * message's dispatch moment); null when sending is allowed now. The window
 * may wrap midnight (20:00–08:00) or not (13:00–14:00); start === end means
 * no window.
 */
export function quietHoursHoldUntil(at: Date, timezone: string, quiet: QuietHours | null): Date | null {
  if (!quiet) return null;
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  if (start === end) return null;
  const now = minutesOfDayIn(timezone, at);
  const inQuiet = start > end ? now >= start || now < end : now >= start && now < end;
  if (!inQuiet) return null;
  const minutesUntilEnd = (end - now + 24 * 60) % (24 * 60);
  const held = new Date(at.getTime() + minutesUntilEnd * 60 * 1000);
  held.setSeconds(0, 0);
  return held;
}
