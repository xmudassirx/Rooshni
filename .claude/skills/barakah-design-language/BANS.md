# Barakah bans — the match-and-refuse register

Read this list before writing any surface, then again while reviewing your
own diff. Each entry is a MATCH (what you are about to write) and the
REFUSAL (what to write instead). If a diff matches a row, the element is
rewritten before handover — a ban is not a style preference, it is a law
with a decision behind it.

## 1. Unearned ticks

**Match:** a green tick, "passed" state, or done-colour on a check the
database has not actually run — a pre-flight category rendered green by
default, a "verified" chip with no verifying row behind it.
**Refuse:** render *pending*, never green. Checks display green only when
an enforcement row proves them.
**Anchor:** decision 19 caveat (Mudassir): the UI must never render an
unearned tick. See the `NOT_YET_RUN` pattern in
`apps/web/app/(app)/inbox/inbox-card.tsx`.

## 2. Machine-knowable state as tags

**Match:** a tag chip carrying something the database already knows —
"overdue", "unread", "has-enquiry", "meta-lead" — as if it were a label a
human chose.
**Refuse:** machine-knowable state renders as derived chips computed from
rows; tags are reserved for human judgment only.
**Anchor:** strategy law (28 Jul 2026, STRATEGY-HANDOVER-31JUL): machine-
knowable state is never taggable; tags = human judgment.

## 3. Dead controls

**Match:** a button, checkbox or menu item whose action pipeline does not
exist yet — a checkbox on rows that cannot be selected, a Delete with no
delete path, a control shipped "for later".
**Refuse:** a control that cannot act is never offered. Ship the surface
without it; the control arrives with its pipeline.
**Anchor:** decision 116 — only communications are selectable; decision
19's unearned-tick rule applied to controls.

## 4. Hardcoded vertical content in chrome

**Match:** vertical vocabulary or content written into product chrome —
"Spouse visa", "IAA", stage names, quiet-hours defaults, legal copy typed
into a component instead of rendered from the installed template.
**Refuse:** vertical content renders from the template (vocabulary, stages,
no-go rules, defaults); chrome stays vertical-blind.
**Anchor:** decision 170 — vertical content renders from the template,
never product chrome.

## 5. Em or en dashes in client-facing drafted copy

**Match:** an em dash (—) or en dash (–) inside machine-drafted
client-facing body text, or a generation prompt that permits them.
**Refuse:** commas and full stops instead; the register check in
`packages/db/src/drafting.ts` (`findRegisterBreach`) fails the harness on a
breach. Scope is generated client-facing bodies only — humans may
punctuate as they wish, and docs/UI chrome are not screened.
**Anchor:** decision 142 (the register rule).

## 6. Prism or gold on anything that is not Light's act

**Match:** gold or the prism gradient reaching chrome — a gold primary
button for a human action, a prism header on a settings panel, gold as a
"premium" flourish.
**Refuse:** gold|prism is Light's channel only: acts, chips, response mesh,
avatars, pins. Chrome takes the user's accent. Rewrite the element in
`--accent` (or ink).
**Anchor:** decision 61 (colour taxonomy law); the `.light-*` classes are
the only lawful carriers.

## 7. Red on anything that is not human-stamp authority

**Match:** `--stamp` red used decoratively — a red delete icon for symmetry,
red as generic "error" styling, red highlights on marketing chrome.
**Refuse:** red means the human stamp: approval owed, approval withheld,
the overdue breach of a human obligation. Generic emphasis takes ink or
amber; destructive-but-ungated actions do not exist (see ban 3).
**Anchor:** decision 61.

## 8. A second integrations door

**Match:** a per-surface settings tab, connect button, or credentials field
anywhere outside Settings → Integrations — "Connect WhatsApp" inside
Conversations, a provider picker with an OAuth flow inside Studio.
**Refuse:** connections live ONCE, in Settings → Integrations; surfaces
keep only behaviour preferences (a small Preferences panel). Link to the
one door instead.
**Anchor:** decision 58; the one-door pattern extends to appearance
(decision 64) and conversation view.

## 9. Consultation fees or booking links in product chrome copy

**Match:** a fee ("£120"), a price promise, or a booking URL written into
product chrome — a button label, an empty state, a helper string.
**Refuse:** fees and booking links are Light's drafted content, composed
per business and passed through the stamp — never chrome. Chrome may name
the *concept* ("Book a consultation" as a nav label rendered from the
template); the figure and the link come from drafted, gated content
(booking URL config is one door: Settings → General, decision 148; fee
promises are a no-go family, Spec 1).
**Anchor:** decisions 148, 170; Spec 1 no-go rules.

---

**On finding a match in someone else's existing code:** flag it, don't
silently fix it — an existing breach may be a signed exception you cannot
see. New code never matches this register, full stop.
