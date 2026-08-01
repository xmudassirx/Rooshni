/**
 * The email sign-off register (Session 15 close ruling + Session 16 PR-F,
 * decision 133e). businesses.settings carries:
 *   email_sign_off       — the sign-off TEXT (default: the firm display name;
 *                          never the owner's personal name, never hardcoded)
 *   email_sign_off_mode  — 'firm_name' (default, shipped) | 'approver'
 *
 * JUDGMENT: the mode lands as the sibling key `email_sign_off_mode` rather
 * than reshaping email_sign_off into an object — Session 15 code reads the
 * text key as a plain string in several places, and a sibling key keeps
 * every existing reader true.
 *
 * Approver mode is WYSIWYS-preserving BY CONSTRUCTION: render and stamp both
 * pass the stored body through the ONE deterministic resolver below — the
 * card shows the body with the approver's name exactly where the stamp act
 * will write it, the stamp act re-derives from the stored body (never from
 * the client's copy), the compliance check re-runs on the exact resolved
 * words with the carried attestation (decision 132's edited-body semantics),
 * and the dispatched body records the resolved name. When the resolver
 * cannot find the sign-off line it changes NOTHING — render and dispatch
 * then agree on the unresolved firm form, so what is seen at stamp is what
 * sends in every branch.
 */

export type SignOffMode = "firm_name" | "approver";

export function resolveSignOffMode(settings: Record<string, unknown> | null | undefined): SignOffMode {
  return settings?.email_sign_off_mode === "approver" ? "approver" : "firm_name";
}

/** The configured sign-off text — the firm display name is the only shipped
 * default (founder-ruled, Session 15 close). */
export function resolveSignOffText(
  settings: Record<string, unknown> | null | undefined,
  businessName: string
): string {
  const raw = settings?.email_sign_off;
  return typeof raw === "string" && raw.trim() ? raw.trim() : businessName;
}

/**
 * Replace the sign-off line — the LAST non-empty line, when it exactly
 * equals one of the known candidates (the configured text, the firm name,
 * or a previously resolved approver name) — with `toName`. Returns null when
 * no candidate matches: the caller renders and sends the body unchanged,
 * and WYSIWYS holds trivially.
 */
export function resolveSignOffBody(
  body: string,
  candidates: string[],
  toName: string
): string | null {
  const clean = candidates.map((c) => c.trim()).filter((c) => c !== "");
  if (!clean.length || !toName.trim()) return null;
  const lines = body.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    if (clean.includes(line)) {
      if (line === toName.trim()) return null; // already resolved to this name
      lines[i] = lines[i]!.replace(line, toName.trim());
      return lines.join("\n");
    }
    return null; // the last non-empty line is not a known sign-off — change nothing
  }
  return null;
}
