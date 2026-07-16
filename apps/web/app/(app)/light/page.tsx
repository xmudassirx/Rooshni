import Link from "next/link";

import { getAppContext } from "@/lib/server/context";
import { getLightAccess } from "@/lib/server/queries";

import { LightComposer } from "./light-composer";

export const dynamic = "force-dynamic";

function PanelHead({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="flex flex-wrap items-center gap-2 border-b border-rule bg-paper px-4 py-3 font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-soft uppercase">
      {children}
    </h2>
  );
}

export default async function LightPage() {
  const [{ actor }, access] = await Promise.all([getAppContext(), getLightAccess()]);
  const firstName = actor.display_name.split(" ")[0];

  return (
    <div className="mx-auto max-w-[820px]">
      <div className="px-0 pt-8 pb-5 text-center">
        <div className="light-spark mb-2 text-3xl">✦</div>
        <h1 className="mb-2 font-display text-[32px] font-extrabold">
          What&rsquo;s on your mind, {firstName}?
        </h1>
        <p className="mx-auto max-w-[560px] text-[13.5px] text-ink-soft">
          Ask, instruct, correct — one conversation, and everything it does
          lands where it belongs: tasks under their days, drafts in your
          Approval Inbox, every act on The Record.
        </p>
      </div>

      <LightComposer />

      <div className="glass mt-5.5 overflow-hidden rounded-xl">
        <PanelHead>Recent conversations</PanelHead>
        <div className="px-5 py-6 text-center text-[13px] text-ink-soft">
          No conversations yet — threads appear here once Light&rsquo;s chat is
          wired in a later session. Nothing lives only in a thread.
        </div>
      </div>

      <div className="glass mt-4 overflow-hidden rounded-xl">
        <PanelHead>
          Who can talk to Light · access is a grant, like everything else
          <span className="light-chip ml-1 rounded px-2 py-0.5 font-mono text-[9.5px] font-bold tracking-[.14em] uppercase">
            Phase 2 · Mock
          </span>
        </PanelHead>
        <div className="flex flex-col py-1.5">
          {access.map((member) => (
            <div
              key={member.name}
              className="grid grid-cols-[minmax(140px,250px)_1fr] items-center gap-5 border-b border-rule px-5 py-3.5 text-[13.5px] last:border-b-0"
            >
              <b>{member.name}</b>
              <span className="text-[12.5px] text-ink-soft">
                {member.role === "owner"
                  ? "full · every surface their grants reach"
                  : "scoped to their grants · enable/disable in Team & Access"}
              </span>
            </div>
          ))}
          <Link
            href="/settings"
            className="grid grid-cols-[minmax(140px,250px)_1fr] items-center gap-5 px-5 py-3.5 text-[13.5px] hover:bg-paper-deep"
          >
            <b>Manage team access</b>
            <span className="text-[12.5px] text-ink-soft">
              → Settings / Team &amp; Access — toggle per person, changes on The
              Record
            </span>
          </Link>
        </div>
      </div>

      <p className="mt-3.5 text-center font-mono text-xs text-ink-faint">
        THE CHAT IS A FRONT DOOR, NOT A SYSTEM OF RECORD — NOTHING LIVES ONLY IN
        A THREAD. WHAT LIGHT DOES HERE PASSES THE SAME GATES AS EVERYWHERE ELSE.
      </p>
    </div>
  );
}
