import type { ReactNode } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { getAppContext } from "@/lib/server/context";
import { getInboxCount } from "@/lib/server/queries";

// Everything in the shell renders against the live database on every request.
export const dynamic = "force-dynamic";

export default async function ShellLayout({ children }: { children: ReactNode }) {
  const [{ business, actor, membershipRole }, inboxCount] = await Promise.all([
    getAppContext(),
    getInboxCount(),
  ]);

  return (
    <AppShell
      businessName={business.name}
      userName={actor.display_name}
      userRole={membershipRole}
      inboxCount={inboxCount}
    >
      {children}
    </AppShell>
  );
}
