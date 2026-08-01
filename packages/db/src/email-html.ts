/**
 * The HTML email dress (Session 19, founder pre-ruling PR-iii).
 *
 * Outbound emails wear a minimal, honest HTML wrapper: the firm's display
 * name and its regulated-status line (both read from Settings — the v3
 * template's "regulated status feeds email footers"; the strings are the
 * firm's own values, never hardcoded per vertical), around the body rendered
 * as clean typographic HTML. Paragraphs and links, nothing else: no
 * marketing chrome, no images, no tracking pixels, ever.
 *
 * WYSIWYS holds by construction (the decision 140 pattern): rendering is ONE
 * deterministic pure function over the STORED plain body — the stamp card's
 * preview and the dispatched mail call the same function on the same words,
 * and the plain-text alternative derives from that same body. The inverse
 * (extractEmailPlainText) is exact over render's output, which is what the
 * html/plain parity smoke proves.
 */

export interface EmailIdentity {
  firmName: string;
  /** businesses.settings.regulated_status — the accreditation row the v3
   * template declares; null renders NO regulated line (honest absence,
   * never an invented claim). */
  regulatedStatus: string | null;
}

/** The identity block from the business row + settings — one resolver so the
 * stamp preview and the dispatcher can never disagree. */
export function resolveEmailIdentity(
  businessName: string,
  settings: Record<string, unknown> | null | undefined
): EmailIdentity {
  const raw = settings?.regulated_status;
  const regulatedStatus = typeof raw === "string" && raw.trim() ? raw.trim() : null;
  return { firmName: businessName, regulatedStatus };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** URLs become links whose visible text IS the URL — stripping tags gives the
 * plain body back exactly (the parity law). Trailing sentence punctuation
 * stays outside the link. */
function linkifyLine(line: string): string {
  const parts: string[] = [];
  let last = 0;
  const pattern = /https?:\/\/[^\s]+/g;
  for (const match of line.matchAll(pattern)) {
    let url = match[0];
    let trailing = "";
    while (/[.,;:!?)'"\]]$/.test(url)) {
      trailing = url.slice(-1) + trailing;
      url = url.slice(0, -1);
    }
    parts.push(escapeHtml(line.slice(last, match.index)));
    parts.push(`<a href="${escapeHtml(url)}" style="color:#1f5eff;text-decoration:underline;">${escapeHtml(url)}</a>`);
    parts.push(escapeHtml(trailing));
    last = match.index + match[0].length;
  }
  parts.push(escapeHtml(line.slice(last)));
  return parts.join("");
}

const BODY_START = "<!--body:start-->";
const BODY_END = "<!--body:end-->";

/**
 * Render the plain body + firm identity as the complete HTML mail. Pure and
 * deterministic: same words in, same document out, at preview, stamp and
 * dispatch alike.
 */
export function renderEmailHtml(body: string, identity: EmailIdentity): string {
  const normalised = body.replace(/\r\n/g, "\n").trim();
  const paragraphs = normalised
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map(
      (p) =>
        `<p style="margin:0 0 1em 0;">${p
          .split("\n")
          .map((line) => linkifyLine(line))
          .join("<br>")}</p>`
    )
    .join("\n");

  const footerLines = [escapeHtml(identity.firmName), ...(identity.regulatedStatus ? [escapeHtml(identity.regulatedStatus)] : [])];

  return [
    `<!doctype html>`,
    `<html lang="en-GB">`,
    `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>`,
    `<body style="margin:0;padding:0;background:#ffffff;">`,
    `<div style="max-width:560px;margin:0 auto;padding:24px 16px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1c1c1c;">`,
    BODY_START,
    paragraphs,
    BODY_END,
    `<div style="margin-top:28px;padding-top:14px;border-top:1px solid #dddddd;font-size:12px;line-height:1.5;color:#6b6f76;">${footerLines.join("<br>")}</div>`,
    `</div>`,
    `</body>`,
    `</html>`,
  ].join("\n");
}

function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * The deterministic inverse over render's output: the BODY region's text,
 * exactly the plain body that went in. Reading surfaces use it so a sent
 * html row still reads as words; the parity smoke asserts
 * extractEmailPlainText(renderEmailHtml(body, id)) === normalised body.
 */
export function extractEmailPlainText(html: string): string {
  const start = html.indexOf(BODY_START);
  const end = html.indexOf(BODY_END);
  const region = start >= 0 && end > start ? html.slice(start + BODY_START.length, end) : html;
  return unescapeHtml(
    region
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The words of a communication body whatever its stored format — plain rows
 * pass through; html rows (dispatched dress, PR-iii) read as their body text. */
export function plainTextOfBody(body: string, bodyFormat: string): string {
  return bodyFormat === "html" ? extractEmailPlainText(body) : body;
}
