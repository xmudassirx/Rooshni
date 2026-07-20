# Session 10 handover addendum — connect to the world

Recorded at close, 20 July 2026. The witnessed circuit, the founder's review
items from the live artifacts, and the operating notes the next sessions
inherit. Rulings born here are DECISIONS 90–99; the build's own record is the
Session 10 close report and `docs/SESSIONS.md`.

## The witnessed circuit (Definition of Done)

- **① OUTBOUND — witnessed.** Founder-stamped intro email arrived in a real
  external inbox (Gmail, 20 Jul, neutral greeting rendering from
  `intro_v1` v2), carried by Graph as the firm —
  `communication.sent`, msgid `<9108ebc6-…@xlaw.lawyer>`. The subject-law
  fix was witnessed on a second stamped send (titled "Your enquiry with
  X Law"), and the `hello_world` WhatsApp template landed on the founder's
  handset — `communication.sent`, provider `whatsapp`,
  msgid `wamid.HBgMNDQ3NDk2MTY2NTU1…`. Both rows read `sent` with provider
  ids on `external_refs`; both events on The Record.
- **② INBOUND — witnessed.** A real Meta test lead (founder's details via
  the Lead Ads Testing Tool preview) flowed webhook → signature check →
  idempotent claim → contact + per-channel consent + enquiry at `new_lead`
  ("New") + Conversations thread + `meta_lead_to_consultation` run — the
  intro draft reached the Approval Inbox with no manual nudge. Sixteen
  further REAL ad leads flowed the same path over the weekend, untouched
  by hand.
- **③ TIME — witnessed.** The production cron advanced a live timer
  unaided: `nurture_wait_t2`, planted Friday for +2 real days, fired Sunday
  18:01 and drafted the T+2 nudge. The decision-15 refusal ran at
  compressed clock (§4.4): with all three nudges left unstamped, the close
  step REFUSED — `workflow.auto_close_refused`: "0 of 3 nudges reached the
  client — the drafts died unstamped in the inbox; closing as Unresponsive
  would misattribute the silence" — and the enquiry stayed open at "New",
  outcome none.

## Founder review items from the live artifacts (none block close)

1. **DONE — neutral greeting.** `intro_v1` v2 live + seed copy: "Hello
   {{first_name}}," — behaviour-driven warmth personalisation deferred to
   the memory era; no demographic inference, ever (LIGHT-OPERATING-DOCTRINE;
   decision 97).
2. **DONE — client-facing subject law.** The draft carries its rendered
   template subject; dispatch never uses the internal thread label
   (decision 98). Witnessed on the second stamped send.
3. **HTML email template** — modestly styled: clean typography, X Law
   signature block with firm details; deliberately light-touch for
   deliverability. Later session; body remains plain text until then.
4. **Approval card: expandable context-in-card** — the lead's form answers
   (visa type, message, source, consent) above the draft, so the founder can
   glance and stamp without leaving the inbox. UI session item.
5. **Approval Inbox: History tab** — Approved / Rejected, 7/30-day filter,
   rows linking to thread + The Record; the default view stays
   stamps-owed-only. Refinement (founder, at close): a stamped row shows a
   transient "✓ Stamped — on The Record" state before leaving the view,
   never disappearing instantly. UI session item.
6. **Query-aware drafting** — Light drafts against the lead's form answers
   within the knowledge pack, replacing the fixed intro template. Headline
   requirement for the Phase 2 drafting session.

## Operating notes inherited by the next sessions

- **Shadow mode holds (decision 99).** Real leads keep flowing; Brevo
  handles them; Barakah's auto-drafts are rejected by the founder with the
  stated reason. Every new lead re-creates the chore — exiting shadow mode
  is a GO-LIVE tick, and at exit the blocked shadow runs (16 at close,
  growing) are cancelled through the gated pipeline or purged with the demo
  data.
- Two ACTIVE lead forms ("New Template", "Standard form-converted") collect
  no email or phone — their leads ingest but their intro drafts sit Blocked
  at pre-flight (no consented channel). Correct behaviour; worth a form
  audit on the Meta side.
- The failed Friday dispatch row (`…32ca4404`, Graph access denied under
  the old two-call adapter) stays as the visible record of the failure
  state working; its redraft chain is archived and evented.
