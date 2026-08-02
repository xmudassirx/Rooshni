/*
 * Defect-trio hotfix (2 Aug 2026, item 2) — one formatter for "sends
 * [time]" wherever a quiet-hours hold renders. The INSTANT always comes off
 * the row (communications.scheduled_for — the truth the tick honours); this
 * only words it. British English; the viewer's clock renders the wall time.
 */

export function formatSendsAt(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const sameDay = at.toDateString() === now.toDateString();
  if (sameDay) return time;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (at.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  return `${at.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${time}`;
}
