# Go-live checklist

Things that MUST change the day real X Law leads flow through the system.
Add to this list during build; check items off only at go-live.

- [ ] **Set `TIME_SCALE=1` in Vercel** (production environment). Dev runs at
      1440 (1 day → 1 minute); production timers must run at real time.
- [ ] Upgrade infra off free tiers (master context §3.8): Supabase paid,
      Vercel Pro — Vercel Hobby prohibits commercial use and hard-pauses at
      limits (~$45/mo combined).
- [ ] **Purge seed/demo data** before real leads flow: the fixture Meta leads
      (contacts, enquiries, tasks), Light's demo drafts and threads
      (`01980000-…-0000005xx`), and the events they wrote. Spec 4 §6 measures
      acceptance from the ledger — test rows must not sit in those numbers.
      (Events are append-only for every API role; the purge is a one-off
      superuser act at go-live.)
