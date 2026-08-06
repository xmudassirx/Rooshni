/*
 * Session 30, Workstream C (founder-witnessed at click-review): after a
 * successful contact archive the browser lands on the Contacts book, never
 * back on the archived contact's page (which honestly 404s once the read
 * layer refuses archived rows). The target lives here, pure, so the action
 * and the harness prove the same destination.
 */
export function archivedContactRedirect(displayName: string): string {
  return `/contacts?archived=${encodeURIComponent(displayName)}`;
}
