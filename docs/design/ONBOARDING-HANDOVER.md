# Onboarding redesign — signed handover (Design pass 4, 16 July 2026)

Signed by Mudassir in the Design chat; verdicts on carried questions ruled in
the Strategy chat, 16 July 2026. The seven-step wizard is dead; this replaces
it. Design authority: `docs/design/onboarding-wizard-mockup.html` (Pass 4 v2)
— every rule below is drawn and clickable there.

NUMBERING NOTE: this document originally proposed decisions 76–81. Decisions
77–78 were claimed by session 8 (single-door conversation view; author-side
alignment) before this landed. The six rulings below are 79–84 and are
appended to DECISIONS.md by the onboarding foundations session at close.

## The decision, in one paragraph

Signup is two steps outside the shell (details incl. website URL → plan +
Stripe payment). The crawl fires ONLY on `payment.succeeded` — never on URL
entry — so a failed card or abandoned signup costs zero tokens. Post-payment,
the firm lands in the shell on day one; onboarding continues as **First
Light**: a top-bar pill next to Ask Light (NOT a nav tab), opening a checklist
whose rows are REAL rows in the tasks table with EARNED done-states. When the
last row earns its tick, the pill retires itself and disappears. GHL's
launchpad was the reference; our differences are deliberate: ticks are earned
by each row's own predicate (never self-reported clicks), connections stay
behind the one door, and the surface is temporary chrome, not a permanent tab.

## Rulings — DECISIONS.md 79–84

79. **Two-step signup; payment before the shell.** Step 1: your name, business
    name, email, phone, website URL. Step 2: plan card + Stripe checkout.
    Pilots pay — there is no free tier and no trial wall to remove later.
    No template picker: UK Immigration Advisory v3 applies by default
    (vertical discipline deleted the screen); the vertical lives in
    Settings → General for the day there is a second one.

80. **Crawl-after-payment law.** The website crawl is triggered by the
    `payment.succeeded` webhook, never by URL entry. No AI spend exists for
    an unpaid signup. The URL is held (costs nothing) from step 1.

81. **First Light** is the onboarding surface: a top-bar pill beside Ask
    Light, wearing prism|gold (it is Light's channel — it speaks in Light's
    voice and carries Light's proposals; navigation rows inside the panel
    take accent — the prism is on the proposals, not the furniture).
    It opens a panel of setup rows. It is NOT a sidebar nav item.

82. **First Light rows are real task rows** (tasks table, tagged with
    `first_light` and a predicate key), visible in Tasks too — same rows,
    two doors. Every done-state is EARNED by a deterministic predicate,
    never by dismissing the row. Predicates live as ROWS in a table
    (founder-ruled): state in the database, flips evented on The Record;
    evaluation logic runs server-side. Rows:
    - Confirm business basics → all General rows stamped
    - Connect email & calendar / WhatsApp / Meta → the grant row exists
      (deep-link to Settings → Integrations; state reflects back; the
      panel never renders a credential field — decision 58 holds)
    - Review what Light found → memory proposals tray emptied
      (each confirmed, edited or rejected)
    - Review no-go rules → viewed/acknowledged event (NOTE: the weakest
      tick — earned by acknowledgment, not verifiable state; acceptable
      for Phase 2, never precedent for self-reported done-states)
    - Verify sending domain → DNS checks pass
    - Book walkthrough → calendar event exists, via the product's OWN
      booking-link mechanism over the Calendar integration (founder-ruled:
      dogfood or don't ship it — no third-party booking iframe)
    Meta Lead Forms row is skippable (only-if-running-ads, stated).

83. **First Light retires itself.** When every row is done, the pill
    disappears. Setup chrome must not haunt an onboarded firm. The rows
    remain in Tasks history and on The Record.

84. **The propose→stamp inversion is the first product experience.**
    Post-crawl, Settings → General values arrive as Light's PROPOSALS with
    provenance ("read from jurists.co.uk/about"); the founder confirms or
    corrects each — their first hour teaches the OS's core loop on their own
    data. Crawl findings land as memory PROPOSALS (trust: observed,
    provenance: crawl) — nothing enters memory unvouched. Values the crawl
    couldn't read are honest ("suggestion, not a reading" / blank), never
    silently defaulted-as-if-read.

Noted, not adopted: GHL's earned-credits gamification — scale mechanic for
anonymous self-serve; for pilots the founder is the incentive. Parked Phase 3+.

## Carried questions — RULED (Strategy chat, 16 July 2026)

1. **Pre-active accounts**: 30-day retention, then hard delete — the record
   holds only name, email, phone, URL (no crawl ran, nothing else exists).
   Reminder emails at 24 hours and 7 days, then silence; no drip.
   `account.deleted_unpaid` is evented. Deletion job rides the existing cron.
2. **Crawl ceiling**: hard cap of 50 pages AND a fixed credit ceiling per
   onboarding crawl, whichever bites first — absorbed in the plan, invisible
   to the pilot. The per-action gate stays for anything beyond. A pilot's
   first hour must never contain a bill surprise.
3. **Predicates**: table, not registered code checks — see 82.
4. **Walkthrough booking**: the product's own booking link — see 82.

## Build work implied (session planning)

**Session A — onboarding foundations** (schema, signup pair, Stripe webhook,
pre-active lifecycle). **Session B — First Light** (pill, panel, earned ticks,
basics-confirm modal, true empty states; The Record is never empty on day one
— the firm's first events are already lines). **Session C — the crawler**
(actor on The Record; public pages only, no grant needed for the firm's own
public site; connect-then-crawl unchanged for anything non-public; real page/
finding counts, no percent bars; cost is a credit line) — SCHEDULED AFTER the
Spec 2 memory store exists; the crawl's output is memory proposals and there
is nowhere to put them yet.

SEQUENCE LOCK (founder-agreed): A → integration session → B. First Light's
predicates (grant-exists, DNS-pass) verify infrastructure the integration
session builds; B cannot precede it.

**Consent-mapping** fires at contact-import time, not at onboarding
(unknown = not consented, unchanged).

## Phase discipline
Everything above is Phase 2 scope (pilot acquisition). Nothing here touches
voice, telephony, or Phase 3 surfaces. Mock-one-phase-ahead holds: the mockup
draws only what this list builds.
