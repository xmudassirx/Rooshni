import Link from "next/link";

import { getTeam } from "@/lib/server/queries";

import { InviteButton } from "./team-invite";

/*
 * The Team & Access tab's real content (Session 8): members and agents from
 * the same actors table, one permission system. Each row opens the member
 * page with its grant matrix; the agent row opens the Amal role page.
 */

export async function TeamTab() {
  const team = await getTeam();

  return (
    <div className="glass overflow-hidden rounded-xl">
      <div className="flex items-center gap-2 border-b border-rule bg-paper px-4 py-3">
        <h2 className="font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-soft uppercase">
          Humans and AI, one permission system — no grant on a tool, no tab in
          their sidebar
        </h2>
        <span className="ml-auto">
          <InviteButton />
        </span>
      </div>
      {team.map((member) => (
        <Link
          key={member.actorId}
          href={
            member.kind === "agent"
              ? "/settings/agents/amal"
              : `/settings/team/${member.actorId}`
          }
          className="flex flex-wrap items-center gap-3 border-b border-rule px-4 py-3 last:border-b-0 hover:bg-paper-deep"
        >
          <span
            className={
              member.kind === "agent"
                ? "light-avatar flex size-8.5 shrink-0 items-center justify-center rounded-full text-[13px] font-bold"
                : "flex size-8.5 shrink-0 items-center justify-center rounded-full bg-accent text-[13px] font-bold text-white"
            }
          >
            {member.kind === "agent" ? "✦" : member.name.charAt(0).toUpperCase()}
          </span>
          <span className="min-w-[150px]">
            <span className="block text-sm font-bold">{member.name}</span>
            <span className="block font-mono text-[10px] tracking-wide text-ink-faint uppercase">
              {member.kind === "agent"
                ? "Agent · roles are routing rules"
                : (member.role ?? "member")}
            </span>
          </span>
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {member.grantChips.map((chip) => (
              <span
                key={chip}
                className="rounded-md border border-ledger-line bg-ledger-tint px-2 py-0.5 font-mono text-[10px] font-semibold text-ledger"
              >
                {chip}
              </span>
            ))}
            {!member.grantChips.length ? (
              <span className="rounded-md border border-dashed border-rule px-2 py-0.5 font-mono text-[10px] text-ink-faint">
                no grants yet
              </span>
            ) : null}
            {member.kind === "agent" ? (
              <span className="rounded-md border border-dashed border-ink-faint px-2 py-0.5 font-mono text-[10px] text-ink-faint">
                approvals — structurally unholdable by AI
              </span>
            ) : null}
          </span>
          <span className="ml-auto shrink-0 font-mono text-[10.5px] text-ink-soft">
            {member.grantCount} grant{member.grantCount === 1 ? "" : "s"} →
          </span>
        </Link>
      ))}
      {!team.length ? (
        <p className="px-5 py-6 text-[13px] text-ink-soft">No members visible.</p>
      ) : null}
    </div>
  );
}
