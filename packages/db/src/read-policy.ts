/**
 * The read-layer diet — Session 22, WS5 (founder-ruled): list surfaces read
 * WINDOWS, never unbounded rows, and every displayed count derives from a
 * COUNT aggregate, never from fetching rows to count them (ruling 5e — the
 * law). This module is the policy's one home so the harness can prove it
 * and every surface reads the same numbers.
 */

/** 5a: the Approval Inbox's page sizes — default 20, selector 10/20/50. */
export const INBOX_PAGE_SIZES = [10, 20, 50] as const;
export const DEFAULT_PAGE_SIZE = 20;

/** The hard ceiling any windowed list read may request in one query. */
export const MAX_LIST_WINDOW = 50;

/** 5d: the default window for paginated list surfaces (contacts, pipeline
 * lists, approval history). */
export const DEFAULT_LIST_WINDOW = 20;

/** 5c (Session 23, WS2 — the s22 deferral landing): a conversation opens on
 * its recent TAIL; older messages arrive in further bounded windows on
 * upward scroll. The thread list itself pages by DEFAULT_LIST_WINDOW. */
export const THREAD_TAIL_WINDOW = 30;

export function clampPageSize(requested: number | null | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) return DEFAULT_PAGE_SIZE;
  const allowed = (INBOX_PAGE_SIZES as readonly number[]).includes(requested);
  return allowed ? requested : DEFAULT_PAGE_SIZE;
}

export function clampPage(requested: number | null | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested < 1) return 1;
  return Math.floor(requested);
}

/** PostgREST .range() bounds for a 1-indexed page. The window can never
 * exceed MAX_LIST_WINDOW whatever the caller asks. */
export function pageRange(page: number, size: number): { from: number; to: number } {
  const safeSize = Math.min(Math.max(1, Math.floor(size)), MAX_LIST_WINDOW);
  const safePage = clampPage(page);
  const from = (safePage - 1) * safeSize;
  return { from, to: from + safeSize - 1 };
}
