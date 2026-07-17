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

/** PROVISIONAL — the mockup's regulated-firm default; founder-tunable per business. */
export const QUIET_HOURS_DEFAULT: QuietHours = { start: "20:00", end: "08:00" };

/** businesses.settings.quiet_hours: undefined → default; null → disabled. */
export function resolveQuietHours(settings: Record<string, unknown> | null | undefined): QuietHours | null {
  const raw = settings?.quiet_hours;
  if (raw === null) return null;
  if (raw && typeof raw === "object") {
    const candidate = raw as Partial<QuietHours>;
    if (isHHMM(candidate.start) && isHHMM(candidate.end)) {
      return { start: candidate.start!, end: candidate.end! };
    }
  }
  return QUIET_HOURS_DEFAULT;
}

function isHHMM(value: unknown): value is string {
  return typeof value === "string" && /^\d{2}:\d{2}$/.test(value);
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
