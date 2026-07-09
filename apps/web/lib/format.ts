/** Duration since `iso`, in the mockup's register: "38m", "4h", "2d 3h". */
export function durationSince(iso: string, now = Date.now()): string {
  const ms = Math.max(0, now - new Date(iso).getTime());
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "moments";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rem = minutes % 60;
    return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

/** "Tue 8 Jul, 10:40" — British English, Europe/London. */
export function formatWhen(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  }).format(new Date(iso));
}

/** "21:14:03" — the Record's time column, Europe/London. */
export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Europe/London",
  }).format(new Date(iso));
}

/** "Tuesday 8 July" with Today/Yesterday prefixes — the Record's day headings. */
export function formatDayHeading(iso: string, now = new Date()): string {
  const day = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Europe/London",
  }).format(new Date(iso));
  const key = (d: Date) =>
    new Intl.DateTimeFormat("en-GB", { dateStyle: "short", timeZone: "Europe/London" }).format(d);
  const target = new Date(iso);
  if (key(target) === key(now)) return `Today · ${day}`;
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (key(target) === key(yesterday)) return `Yesterday · ${day}`;
  return day;
}

/** Calendar-day bucket key for grouping, Europe/London. */
export function dayKey(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "short",
    timeZone: "Europe/London",
  }).format(new Date(iso));
}

/** "£1,200" — whole pounds, British English. */
export function formatGBP(value: number): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
  }).format(value);
}
