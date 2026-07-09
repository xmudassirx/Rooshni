# Go-live checklist

Things that MUST change the day real X Law leads flow through the system.
Add to this list during build; check items off only at go-live.

- [ ] **Set `TIME_SCALE=1` in Vercel** (production environment). Dev runs at
      1440 (1 day → 1 minute); production timers must run at real time.
- [ ] Upgrade infra off free tiers (master context §3.8): Supabase paid,
      Vercel Pro — Vercel Hobby prohibits commercial use and hard-pauses at
      limits (~$45/mo combined).
- [x] **Real authentication — required before go-live, OR EARLIER on the
      first second user** (introduced Session 4): the moment anyone besides
      Mudassir (colleague, demo viewer, pilot) touches the app, sign-in is
      built first. **DONE — Session 5 (9 July 2026), triggered early per
      this item's own clause** (Deployment Protection comes off production,
      so "anyone with the URL" stops being only Mudassir): Supabase Auth
      with Google, the `allowed_emails` front door (0018), middleware on
      every app route, and the service client swapped for the user-scoped
      client throughout the web app (decisions 24–26; decision 23 retired).
- [ ] **Purge seed/demo data** before real leads flow: the fixture Meta leads
      (contacts, enquiries, tasks), Light's demo drafts and threads
      (`01980000-…-0000005xx`), and the events they wrote. Spec 4 §6 measures
      acceptance from the ledger — test rows must not sit in those numbers.
      (Events are append-only for every API role; the purge is a one-off
      superuser act at go-live.)
