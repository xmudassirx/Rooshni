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
- [ ] **Register the `feedback` tool and re-key the Feedback nav gate**
      (introduced Session 8): the Feedback surface is grant-gated by design,
      but no `feedback` row exists in the tool registry and adding one is a
      migration. Until that session, `apps/web/app/(app)/layout.tsx` gates the
      nav item on ownership. The proper gate is a grant on a registered
      `feedback` tool — do not go live with the ownership shortcut.
- [ ] **Stripe LIVE keys** (introduced Session 9): `STRIPE_SECRET_KEY`,
      `STRIPE_WEBHOOK_SECRET` and `STRIPE_PRICE_ID` run in TEST MODE until
      the first real pilot pays. Swap to live keys in Vercel, register the
      production webhook endpoint (`POST /api/stripe/webhook`) in the Stripe
      dashboard, and confirm the pinned API version (`STRIPE_API_VERSION`,
      packages/db/src/stripe.ts) against the dashboard default at switch
      time. Where they live: Vercel env vars + Stripe dashboard. What they
      grant: charging real cards. Rotation: Stripe dashboard, on demand.
- [ ] **Verify the pre-active delete job against production timers**
      (introduced Session 9): the sweep rides the workflow tick with
      `TIME_SCALE` applied — after the production `TIME_SCALE=1` flip,
      verify on the ledger that reminders fire at real 24h/7d and the hard
      delete + `account.deleted_unpaid` event at real 30 days, not before.
- [ ] **Resend production sending domain = barakahx.com** (introduced
      Session 9, founder-ruled): verify the domain in Resend (SPF/DKIM),
      set `PLATFORM_MAIL_FROM` to a barakahx.com address and swap
      `RESEND_API_KEY` to the production key. Platform mail and tenant
      comms are separate pipes permanently — Graph must never carry
      platform email.
- [ ] **Purge the DoD circuit test tenant** (introduced 17 July 2026, the
      Session 9 acceptance circuit): account `019f6f0a-291e-7d8f-961b-d3a907935699`
      ("Pilot Test" / business "Jurists Pilot", signup email
      pilot-test@barakahx.com), its actors, grants, First Light task and
      predicate rows, allowlist row, Stripe test-mode customer/subscription,
      and the `stripe_events` circuit rows. Its ledger events are append-only;
      they go with the one-off superuser purge at go-live like the other
      fixture events.
- [ ] **Microsoft sign-in before the first external pilot** (recorded
      17 July 2026, founder-ruled fast-follow, outside Session 9's scope):
      signup states the Google constraint on the email field; the Supabase
      Azure provider (our app registration exists) lifts it. Until then a
      pilot's signup email must be Google-signable.
