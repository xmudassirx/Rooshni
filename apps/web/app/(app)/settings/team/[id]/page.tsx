import Link from "next/link";
import { notFound } from "next/navigation";

import { HonestButton } from "@/components/ui/honest-button";
import { getMemberDetail } from "@/lib/server/queries";

import { PermissionMatrix } from "./matrix-client";

export const dynamic = "force-dynamic";

export default async function MemberPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const member = await getMemberDetail(id);
  if (!member || member.kind !== "human") notFound();

  return (
    <>
      <div className="mb-3.5">
        <Link
          href="/settings"
          className="font-mono text-xs font-semibold tracking-wide text-ink-soft hover:text-ink"
        >
          ← Back to Team &amp; Access
        </Link>
      </div>
      <div className="glass rounded-xl px-5 py-4.5">
        <div className="flex flex-wrap items-start gap-3.5">
          <div className="flex items-center gap-3">
            <div className="flex size-11 items-center justify-center rounded-full bg-accent text-[17px] font-bold text-white">
              {member.name.charAt(0).toUpperCase()}
            </div>
            <div>
              <h1 className="font-display text-[22px] font-extrabold">{member.name}</h1>
              <div className="mt-0.5 font-mono text-xs font-semibold tracking-wide text-accent uppercase">
                {member.role ?? "member"} · calendar: not connected
              </div>
            </div>
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            <HonestButton notice="Working hours & time-off — booking flows offer only their calendar free/busy ∩ these hours. Arrives with the calendar session.">
              Availability
            </HonestButton>
            <HonestButton notice="Suspend access freezes all grants at once — membership kept, access frozen, evented. The write wires with the grant-management session.">
              Suspend access
            </HonestButton>
          </div>
        </div>
      </div>

      <div className="glass mt-4 overflow-hidden rounded-xl">
        <h2 className="border-b border-rule bg-paper px-4 py-3 font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-soft uppercase">
          Permission matrix — every flip is a grant row, evented ·{" "}
          {member.grants.length} live grant{member.grants.length === 1 ? "" : "s"}
        </h2>
        <PermissionMatrix member={member} />
      </div>

      <p className="mt-3 font-mono text-xs text-ink-faint">
        FIELD-LEVEL VISIBILITY INSIDE EACH TAB (E.G. HIDE FEE COLUMNS FROM CASEWORKERS) IS
        TEMPLATE CONFIGURATION — SURFACE_VISIBILITY ON EACH FIELD DEFINITION.
      </p>
    </>
  );
}
