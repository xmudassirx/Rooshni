import Link from "next/link";

import { PageHead } from "@/components/shell/page-head";

import { CreatePostButton, PreferencesButton } from "./social-shared";

/*
 * view-social, master mockup v2 — built AS DRAWN (founder rule: function is
 * settled, composition is not; no redesign here). No social store, no Meta
 * connection: every figure is an honest not-yet.
 */

const WEEK = ["M", "T", "W", "T", "F", "S", "S"];

export default function SocialHomePage() {
  return (
    <>
      <PageHead
        title="Social"
        sub="Light drafts, you stamp, Meta publishes — reach comes home as events, not vanity"
        actions={
          <>
            <PreferencesButton />
            <CreatePostButton />
          </>
        }
      />

      <div className="mb-4 grid grid-cols-3 gap-3 max-[860px]:grid-cols-1">
        <div className="light-panel rounded-lg px-3.5 py-3">
          <div className="light-head font-mono text-[9.5px] tracking-[.12em] uppercase">
            ✦ Awaiting your stamp
          </div>
          <div className="my-1 font-display text-[26px] font-extrabold">0</div>
          <div className="text-[11.5px] leading-normal text-ink-soft">
            Nothing pending — the week&rsquo;s drafts will land as one batch, one stamp.
          </div>
        </div>
        <Link href="/social/analytics" className="glass rounded-lg px-3.5 py-3 hover:border-accent">
          <div className="font-mono text-[9.5px] tracking-[.12em] text-ink-faint uppercase">
            This week
          </div>
          <div className="my-1 font-display text-[26px] font-extrabold text-ink-faint">—</div>
          <div className="text-[11.5px] leading-normal text-ink-soft">
            Reach and engagement come home as events — none recorded yet.
          </div>
        </Link>
        <div className="glass rounded-lg px-3.5 py-3">
          <div className="font-mono text-[9.5px] tracking-[.12em] text-ink-faint uppercase">
            Channels
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11.5px]">
            <span className="rounded border border-rule bg-paper-deep px-1.5 py-0.5 font-mono text-[9.5px] font-bold tracking-wide text-ink-soft uppercase">
              FB · not connected
            </span>
            <span className="rounded border border-rule bg-paper-deep px-1.5 py-0.5 font-mono text-[9.5px] font-bold tracking-wide text-ink-soft uppercase">
              IG · not connected
            </span>
            <span className="rounded border border-rule bg-paper-deep px-1.5 py-0.5 font-mono text-[9.5px] font-bold tracking-wide text-ink-faint uppercase">
              LinkedIn · Phase 3
            </span>
          </div>
          <div className="mt-2 font-mono text-[9px] text-ink-faint uppercase">
            Connections live once — Settings → Integrations
          </div>
        </div>
      </div>

      <div className="glass mb-4 overflow-hidden rounded-xl">
        <h2 className="border-b border-rule bg-paper px-4 py-3 font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-soft uppercase">
          This week at a glance · tap through to the calendar
        </h2>
        <Link href="/social/calendar" className="grid grid-cols-7 gap-2 px-4 pt-3.5 pb-2">
          {WEEK.map((d, i) => (
            <span key={i} className="rounded-lg border border-rule py-2.5 pb-3 text-center">
              <b className="mb-1.5 block font-mono text-[10px] text-ink-faint">{d}</b>
              <span className="inline-block size-2 rounded-full" />
            </span>
          ))}
        </Link>
        <p className="px-4 pb-3 font-mono text-[8.5px] text-ink-faint uppercase">
          Green = published · gold = ✦ awaiting stamp · outline = your draft · nothing
          planned yet — quiet weekends by preference
        </p>
      </div>

      <div className="light-panel rounded-xl px-4 py-3.5">
        <h2 className="light-head mb-2 font-mono text-[10.5px] font-semibold tracking-[.14em] uppercase">
          ✦ Light noticed
        </h2>
        <p className="text-[13px] text-ink-soft">
          Nothing yet — slot suggestions and repurposing proposals grow out of
          real analytics events, and none exist. When they do, accepting one is
          a preference change, on The Record.
        </p>
      </div>
    </>
  );
}
