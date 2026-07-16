# Phase 1 lead log — baseline (CLOSED, founder-ruled 16 July 2026)

Source: GHL deals export (`export_deals_31.csv`), 50 Facebook leads, 8–15 July 2026.
Founder ruling: the log closes on this export; the "before" is measured from these
numbers plus one founder gut estimate. Live post-go-live metrics measure the "after".

## The before-world in numbers

| Metric | Value |
|---|---|
| Leads captured | 50 (8 days, ~6.3/day, 100% Facebook) |
| Consultations booked | **0** |
| Deals won | **0** |
| Junk leads | 17 (34%) |
| Lost to competitor | 1 |
| Open in follow-up stages | 30 (22 at 24h, 8 at 2–5 days) |
| International-number parked | 2 |
| Times-contacted recorded | 0 of 50 (field empty — manual tracking non-existent) |
| Last-contacted recorded | 0 of 50 |
| Person-hours on lead triage | **~2 hours EVERY DAY** (recent leads + walking all stages) |
| Person-minutes per lead | ~19 min (16h over the 8-day window / 50 leads) |

Daily arrivals: {'08-07-2026': 7, '09-07-2026': 3, '10-07-2026': 6, '13-07-2026': 22, '15-07-2026': 12}

## The manual pipeline — 12 stages (GHL, as operated)
New · 24 hour Follow up · 2-5 Days Follow up · Follow up (After 6 PM) ·
International Number · Pending Qualification · Qualified · Meeting scheduled ·
In negotiation · Dead Lead · Won · Lost

**Finding — timers wearing stage costumes:** four of the twelve ("24 hour",
"2-5 Days", "After 6 PM", "International Number") are not pipeline semantics;
they encode WHEN to act or a triage filter as a column, because the tool has no
brain. Barakah retires all four: timers are workflow data (Spec 4), junk and
international-number handling is triage with a reason on The Record. The true
semantic pipeline is: New -> Pending Qualification -> Qualified -> Meeting
scheduled -> In negotiation -> Won / Lost / Dead. The Session 8 Meta wiring maps
inbound leads to THIS set, not GHL's twelve (engagement.stage, decision 60).

## What this baseline proves
1. The manual system cannot measure its own follow-up effort (empty tracking columns on all 50 rows).
2. A third of ad spend buys junk that a human must still touch to discard.
3. Conversion in the captured window is zero — any booked consultation is an improvement.
4. Two person-hours daily are spent simulating automation by hand — walking
   follow-up columns that exist only to remember time.

## Phase 1 acceptance targets (replacing the beats-the-two-week-log test)
- First response to a new lead: minutes, not hours — with the touch on The Record.
- Junk auto-triaged with a stated reason, founder time on junk ≈ 0.
- ≥ 1 consultation booked within the first two live weeks (baseline: 0).
- Daily lead-triage sitting reduced from ~2 hours to stamp-time in the Approval Inbox (minutes).

## Consequence for decision 15 (auto-close, due Session 8)
Auto-close timers ship as provisional defaults and are tuned from live ledger data
after go-live — the export contains no reply-latency data to calibrate them.
The canvas already marks these timers PROVISIONAL; this ruling confirms the path.
