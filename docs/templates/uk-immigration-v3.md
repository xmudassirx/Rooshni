# Vertical template — UK Immigration Advisory, v3

Status: founder content, signed 20 July 2026 (Strategy chat). This is the
definition decision 79 references ("UK Immigration Advisory v3 applies by
default"). Installed by Session B's activation path; the template system
renders from THIS document's structures, never from hardcoded product chrome
(session-9 addendum rule). British English throughout.

## Identity

- key: `uk_immigration_advisory`, version: 3
- Display: "UK Immigration Advisory"
- Signup footer line (rendered from template, not hardcoded):
  "UK Immigration Advisory · v3 applies — Barakah is built for immigration
  firms first. Vertical settings live in Settings → General."

## Vocabulary

- Lead/matter noun: **enquiry** (never "deal", never "opportunity")
- Client noun: **client** (prospective: **enquirer**)
- Consultation noun: **consultation** (never "demo", never "meeting" in
  client-facing copy)

## Pipeline — the semantic stage set

Source of truth: LEAD-LOG-BASELINE.md's finding — timers are workflow data,
never stages. Stages (key → display):

1. `new_lead` → New
2. `pending_qualification` → Pending qualification
3. `qualified` → Qualified
4. `consultation_booked` → Consultation booked
5. `consultation_held` → Consultation held
6. `instructed` → Instructed
7. Terminal: `won` → Won · `closed_lost` → Lost · `unresponsive` →
   Unresponsive · `disqualified` → Disqualified

Explicitly refused (Brevo/GHL residue): 24-hour / 2-5-day / after-6PM
follow-up columns, "International Number" parking. Timer state lives on
workflow runs; junk and international handling is triage with a reason on
The Record.

## Business-identity fields (Settings → General; the wizard fills these)

Standard set: business name, address, locale/timezone/currency (default
en-GB / Europe/London / GBP), languages, business hours, quiet hours
(default 20:00–08:00).

Vertical extension — **Regulated status** (the accreditation row; renders
in First Light and Settings from the template, never hardcoded):
- IAA Level 1 (advice and assistance)
- IAA Level 2 (casework)
- IAA Level 3 (advocacy and representation)
- SRA-regulated solicitor firm
- Not yet accredited / other (free text)
Regulated status feeds email footers, WhatsApp template copy, and the
Phase 3 voice disclosure. It is display + compliance data, not a gate.

## No-go rules (seed set, firm-editable, acknowledged in First Light)

1. Light never states or implies a guarantee of visa success, application
   outcome, or Home Office timescales.
2. Light never gives case-specific legal advice in an unstamped channel —
   drafts may explain process and generalities; advice happens in
   consultations with the humans.
3. Light never quotes fees beyond the firm's published consultation fee
   without a stamp.
4. Light never contacts a party identified as the opposing side, a
   sponsor's employees, or the Home Office.

## Knowledge pack seed (Phase 2 drafting session consumes this)

Categories the pack expects (firm uploads/curates; crawl proposes):
service descriptions per visa route (Skilled Worker, Spouse/Family, ILR,
Naturalisation, Student, Visitor, EUSS, Asylum & Human Rights, Appeals),
published fees, consultation booking policy, the firm's tone exemplars
(3–5 approved past emails), FAQ (financial requirement, evidence formats,
processing expectations — generic, non-advisory).

## Workflow seed

`meta_lead_to_consultation` v1 as shipped (Session 10): intro on ingest →
nudges at T+1, T+2, T+4 business days (PROVISIONAL, AUTO_CLOSE_POLICY) →
auto-close only when nudges were genuinely delivered (decision 96/15).
Booking link on every touch. Quiet hours respected; WhatsApp template for
out-of-window sends (wa_template mapping is a GO-LIVE item).

## First Light rows (template contribution)

The standard eight (handover doc), with the vertical supplying:
- The accreditation row content (Regulated status options above)
- The no-go seed set for the review/acknowledge row
- The knowledge-pack category checklist for the crawl-review row
Meta Lead Forms row: skippable, "only if running ads" stated. Form
hygiene note surfaces here too: forms must collect email or phone —
a channel-less form yields Blocked drafts (Session 10 operating note).

## Nurture (pre-active signups, platform-side — not tenant workflow)

24h reminder + resume (shipped) · day-3 product story (the 2-hours-a-day
problem, the stamp loop) · day-7 founder's note with walkthrough offer ·
then silence. Honest copy only: capability claims, no invented social
proof, until real pilot numbers exist. Unsubscribe on all.

## Versioning

v3 supersedes the informal v1 (X Law seed) and the unshipped v2 sketch.
Changes to this template are re-issues with a version bump, evented,
never rewrites — the template-copy law from Session 10's greeting fix
applies to the whole template.
