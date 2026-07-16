import type { ReactNode } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { getAppContext } from "@/lib/server/context";
import { getInboxCount, getOpenTaskCount } from "@/lib/server/queries";

// Everything in the shell renders against the live database on every request.
export const dynamic = "force-dynamic";

export default async function ShellLayout({ children }: { children: ReactNode }) {
  const [{ business, actor, membershipRole }, inboxCount, taskCount] =
    await Promise.all([getAppContext(), getInboxCount(), getOpenTaskCount()]);

  // JUDGMENT: Feedback is a grant-gated surface, but no `feedback` tool row
  // exists in the registry yet and registering one is a migration (out of
  // scope). Until that session, the gate keys on ownership — see
  // docs/GO-LIVE.md (Session 8, Lane B).
  const showFeedback = membershipRole === "owner";

  return (
    <AppShell
      businessName={business.name}
      userName={actor.display_name}
      userRole={membershipRole}
      inboxCount={inboxCount}
      taskCount={taskCount}
      showFeedback={showFeedback}
    >
      {children}
    </AppShell>
  );
}
