# Go-live checklist

Things that MUST change the day real X Law leads flow through the system.
Add to this list during build; check items off only at go-live.

- [x] **Set `TIME_SCALE=1` in Vercel** (production environment). Dev runs at
      1440 (1 day → 1 minute); production timers must run at real time.
      **DONE EARLY — founder set it on production, 17 July 2026:** the public
      signup surface (Session 9) made it urgent — a real visitor's abandoned
      signup must not receive its "24h" reminder after one minute.
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
- [ ] **Rule on the Bikayga test tenant + close its sign-in door** (introduced
      Session 14, auth forensics — recommendation awaiting founder ruling):
      account `019f7082-2f2e-7e3d-98a1-9b4aed81f786` ("Ahsan Raja" /
      business "Bikayga", signup email bikaygapl@gmail.com) is Ahsan's
      activated test-mode signup of 17 Jul 15:37 BST — the activation door
      created its auth user via the admin API (provider "email",
      auto-confirmed, never signed in), an `allowed_emails` row and standing
      activation grants, all evented on the ledger. Isolation held (single
      membership, own business only, zero sessions ever), but the allowlist
      row is an open sign-in door for a non-customer. Recommended: archive
      the `allowed_emails` row now (reversible, evented) and fold the tenant
      — auth user included — into the Pilot-Test purge pattern above at
      go-live; never hard-delete the tenant outside that purge (its ledger
      events are append-only).
      *Ruled and half-executed at Session 14 close (decision 125): the
      allowlist row is ARCHIVED (31 Jul 2026, ledger event
      `019fb7d1-f883-7c80-9f44-7b0004f33c33`, via the new
      `allowlist:archive` chore script). Remaining before this line ticks:
      the tenant + auth user go with the Pilot-Test purge at go-live.*
- [ ] **Microsoft sign-in before the first external pilot** (recorded
      17 July 2026, founder-ruled fast-follow, outside Session 9's scope):
      signup states the Google constraint on the email field; the Supabase
      Azure provider (our app registration exists) lifts it. Until then a
      pilot's signup email must be Google-signable.
- [ ] **Send-pipeline secrets** (introduced Session 10): `AZURE_CLIENT_SECRET`
      + `GRAPH_SENDER_ADDRESS` (Graph app-only mail — sends as the firm's
      mailbox; the Azure client secret expires per its app-registration
      clock, ~730 days — record the expiry date and rotate in the Azure
      portal), `WHATSAPP_ACCESS_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID`
      (WhatsApp Cloud API — sends as the firm's WhatsApp number; rotate via
      Meta Business system-user tokens). Where they live: `.env.local` +
      Vercel env vars. What they grant: sending real messages as the firm.
- [ ] **Meta webhook secrets** (introduced Session 10): `META_APP_SECRET`
      (signature check — webhook fails closed without it),
      `META_VERIFY_TOKEN` (subscription handshake), `META_ACCESS_TOKEN`
      (leads_retrieval — the webhook ping carries ids only; field data is
      fetched). Live in `.env.local` + Vercel; rotate via the Meta app
      dashboard / system-user token. Register the webhook (Page
      subscriptions → leadgen → `POST /api/meta/leads`) and bind the page:
      `npm run wire-meta --workspace=@rooshni/db -- <page_id>`.
- [ ] **Meta App Review before non-tester lead traffic** (introduced
      Session 10): a dev-mode app with the firm's own system-user token
      reads its own page's leads, which covers the pilot; App Review
      (leads_retrieval, pages_manage_metadata) is required before the app
      serves any page outside the firm's Business Manager. The working demo
      this session produces is the review submission's evidence.
- [ ] **WhatsApp template approval** (introduced Session 10): the nurture
      T+2 WhatsApp nudge dispatches as a Meta-approved TEMPLATE (session-
      window law; free-form to a silent lead is undeliverable and the
      pre-flight refuses it). Create/approve the template in WhatsApp
      Manager, then set `message_templates.attributes.wa_template =
      {"name": "...", "language": "...", "params": ["first_name", ...]}`
      on `nurture_t2_v1` so drafts carry it. Until then the nudge falls
      back to email (decision 50) — WhatsApp nudges silently don't exist.
      *Progress 30 Jul 2026 (founder chore): `enquiry_intro` (Utility) and
      `enquiry_nudge` (Marketing — Meta's classifier ruling; approved body
      opens "An update on your enquiry…") approved on the TEST WABA, en_GB —
      mapped onto `intro_v1` and `nurture_t2_v1` (seed + live, evented);
      hello_world is no longer load-bearing. Params founder-ruled to match
      the APPROVED bodies: intro and nudge carry ONE variable ({{1}} =
      client first name; firm name baked in); `consultation_reminder`
      carries THREE ({{1}} name, {{2}} date, {{3}} time). WYSIWYS re-issue
      DONE 30 Jul (decisions 118/119): per-channel bodies live as intro_v1
      v3 + nurture_t2_v1 v2, whatsapp bodies verbatim from the Test WABA
      (`WHATSAPP_WABA_ID`, now in env). Still open before this line ticks:
      map `consultation_reminder` when it clears review, and RE-SUBMIT all
      three on the production WABA at cutover with the regulated-status
      footer per Settings → General — then re-verify the bodies against
      the production WABA and re-issue if Meta's review alters a word.*
- [ ] **Vercel cron is live cadence** (introduced Session 10):
      `apps/web/vercel.json` ships a per-minute cron for
      `GET /api/workflows/tick` — per-minute cadence requires Vercel Pro
      (already on this list; now sequence-forced — Hobby refuses sub-daily
      schedules at deploy). After merge, verify the cron appears in the
      Vercel dashboard and the tick returns ok with `CRON_SECRET` set.
      *Session 14 amendment (decision 121, founder-ruled in-prompt): the
      cadence is now every 5 minutes (`*/5 * * * *`) — the egress ruling.
      Dispatch-on-stamp stays inline and instant; quiet-hours releases and
      due timers land within 5 minutes of their moment. The Pro-plan
      sequence note above still applies to any sub-daily schedule.*
- [ ] **Exit shadow mode** (introduced Session 10 close, decision 99): real
      Meta leads currently run BOTH pipelines — Brevo handles them, Barakah
      ingests and drafts, and the founder rejects every draft with "shadow
      mode — handled by existing pipeline". Exiting = the founder stops
      rejecting and starts stamping; at that moment cancel the accumulated
      blocked shadow runs through the gated pipeline (16 at Session 10
      close, growing with every lead) or fold them into the demo-data
      purge. Until this tick, the daily rejection chore recurs.
- [ ] **Purge first-light-drive artefacts** (introduced Session 11): the
      `first-light:drive` script demonstrates the connect predicates by
      creating REAL integration actors ("… (driven)") and grants on the
      target business — the honest service-side connect the DoD asked for.
      Before go-live, revoke those grants through the pipeline (or fold the
      rows into the test-tenant purge) so no "(driven)" connection outlives
      its demonstration. Real OAuth connect flows replace the script.
- [x] **Founder-approved nurture copy** (introduced Session 11): the day-3
      product story and the day-7 founder's note (signed "Mudassir") ship
      builder-drafted in `apps/web/lib/server/platform-mail.ts` — reviewed
      at the Session 11 merge, but re-check the words before the first real
      pre-active signup ages past day 3 with `TIME_SCALE=1`; the day-7 note
      speaks in the founder's own voice and must actually be his.
      *Ticked 30 Jul 2026 on the founder's order (copy chore): the day-7
      note is now his own words verbatim; day-3 aligned, no new claims. The
      note's "[link]" is wired to the signup resume link until a real
      booking URL exists (see the walkthrough-booking session).*
- [ ] **ANTHROPIC_API_KEY in Vercel** (introduced Session 15, PR-3): the
      drafting engine's provider key must be set in Vercel env vars (and
      `.env.local` for local runs) BEFORE the s15 merge deploys — without
      it every generated email draft fails visibly with the recorded reason
      (never a silent stub fallback), and only the WhatsApp template path
      keeps drafting. Env var only, never committed, never logged; note a
      rotation date when issued. Model ids live in ONE module
      (`packages/db/src/model-router.ts`) — a swap is a one-line change.
- [ ] **Pre-migration shadow drafts are compliance-exempt by design**
      (introduced Session 15, ruling C-2): agent drafts created BEFORE 0026
      carry `compliance_required = false` and remain stampable under the
      old deterministic checks; the shadow-mode purge/cancel at exit-shadow
      retires them. Drafts created AFTER 0026 by the pre-merge production
      engine (the window between live apply and the s15 deploy) carry the
      requirement but no recorded check, so they are unapprovable until
      rejected or purged — bulk rejection covers them in the daily shadow
      chore.
- [ ] **Grant Mail.Read (application) + admin consent for inbound email**
      (introduced Session 16, PR-A — Lane C credentials-at-need): the send
      path deliberately holds Mail.Send only; the Graph inbound poll cannot
      read the tenant mailbox until the founder grants the read permission.
      Exact console steps: Azure portal → Microsoft Entra ID → App
      registrations → the existing Barakah app → API permissions → Add a
      permission → Microsoft Graph → Application permissions → Mail →
      **Mail.Read** → Add permissions → **Grant admin consent for <tenant>**.
      Until granted, every poll records a visible ErrorAccessDenied in the
      tick report (fail closed, never silent). Consider Application Access
      Policy scoping (New-ApplicationAccessPolicy) to confine the app to the
      one mailbox — recommended, not required for the pilot.
- [ ] **Register the WhatsApp inbound webhook + wire the bindings**
      (introduced Session 16, PR-A): Meta app dashboard → WhatsApp →
      Configuration → Webhook → Callback URL
      `https://<production-host>/api/whatsapp/webhook`, Verify token =
      `META_VERIFY_TOKEN`'s value → Verify and save → subscribe to the
      **messages** field. If the WhatsApp product lives on a DIFFERENT Meta
      app than the Lead Ads webhook, its App Secret differs and
      `META_APP_SECRET` must match the app that signs this webhook — verify
      before saving. Then bind the tenant:
      `npm run wire-inbound --workspace=@rooshni/db -- --whatsapp <phone_number_id> --mailbox <firm mailbox> <business_id>`
      (the phone-number id is WhatsApp → API Setup; the mailbox is
      GRAPH_SENDER_ADDRESS's value). Unwired inbound fails loudly and is
      retried by Meta once wired.
- [ ] **Graph webhook subscriptions replace the inbound poll** (introduced
      Session 16, PR-A — future tightening, founder-ruled in-prompt): email
      inbound currently rides the 5-minute cron poll; Microsoft Graph change
      notifications (subscription webhooks with clientState validation and
      renewal) deliver near-instant inbound and cut polling egress. Its own
      session; the poll stays the lawful fallback.
- [ ] **Run `npm run supersede:normalise` once after the 0030 live apply**
      (introduced Session 16, PR-B): the migration retires older duplicate
      pending drafts (newest-wins) with a needs_event marker; the chore puts
      each transition on The Record (communication.superseded, reason
      migration_normalisation). The cron sweep self-heals leftovers, but the
      explicit run closes the books the same day. Idempotent.
- [ ] **Set `NEXT_PUBLIC_APP_URL=https://app.barakahx.com` in Vercel**
      (introduced Session 18, founder-approved): the canonical-URL seam
      (`apps/web/lib/app-url.ts`) routes every composed absolute URL —
      nurture email links, signup resume links, the day-7 note's [link],
      unsubscribe footers, Stripe success/cancel URLs, auth redirect
      composition — through this env var when set, request-derived
      otherwise. Set it in the PRODUCTION environment ONLY: previews and
      local must stay unset so click-review previews keep deriving from the
      request. Until set, production behaves exactly as before (request-
      derived), so nothing breaks — but nurture links composed by the cron
      tick ride the tick request's own origin, which is the defect the seam
      closes. The founder adds the var the moment the merge deploys (he
      asked to be told when it is read — it is read from this session's
      merge onward).
- [ ] **Stub-era approved rows never dispatch** (introduced Session 10):
      Session 3/6 demo drafts that were approved in the stub era carry
      `communication.send_stubbed` events; the dispatcher permanently walks
      past them. They leave with the existing demo-data purge items — until
      that purge, they sit `approved` forever by design, and no real message
      is ever sent to the fixture addresses.
