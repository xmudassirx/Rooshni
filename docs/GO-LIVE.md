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
- [ ] **Purge workflow demo data** (introduced Session 6): the demo workflow
      runs and step executions on the two fixture leads, the drafts/tasks the
      runs produced, and the events from compressed-clock rehearsals and
      watches. The seeded `meta_lead_to_consultation` definition and message
      templates are real configuration and STAY.
- [ ] **Replace the STUB send executor** (introduced Session 6): the runner
      NEVER marks anything `sent` — after a human stamp it only logs
      `communication.send_stubbed` on the ledger. The real send pipeline is
      its own session and must add the mark-as-sent pipeline function behind
      the locked approval door (decision 16). No real message leaves the
      system until then — do not go live believing sends are happening.
      The same session must honour decision 51's caveat: the auto-close step
      distinguishes "silent after sent nudges" from "nudges never approved"
      on the ledger — closing as Unresponsive when nudges expired unstamped
      misattributes the silence.
- [ ] **Replace the STUB Meta outcome signals** (introduced Session 6):
      `meta.signal_stubbed` events mark where conversion/junk feedback would
      fire (Spec 4 §4 step 10, 24h cooling). Real wiring = Meta Conversions
      API contract session + wiring session, Marketing API v25.0+.
- [ ] **Set `CRON_SECRET` in Vercel** (all environments) and configure a
      Vercel Cron for `GET /api/workflows/tick` (introduced Session 6). The
      endpoint fails closed (503) until the secret exists. Minute-level cron
      cadence needs Vercel Pro (already on this list); until the cron runs,
      production workflows do not tick.
