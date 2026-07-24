import type { ReactNode } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { FirstLight, type FirstLightBasicsProp } from "@/components/shell/first-light";
import { getAppContext } from "@/lib/server/context";
import {
  getBusinessConfig,
  getFirstLight,
  getInboxCount,
  getOpenTaskCount,
  getTemplateContent,
} from "@/lib/server/queries";

// Everything in the shell renders against the live database on every request.
export const dynamic = "force-dynamic";

export default async function ShellLayout({ children }: { children: ReactNode }) {
  const [{ business, actor, membershipRole }, inboxCount, taskCount, firstLight] =
    await Promise.all([getAppContext(), getInboxCount(), getOpenTaskCount(), getFirstLight()]);

  // JUDGMENT: Feedback is a grant-gated surface, but no `feedback` tool row
  // exists in the registry yet and registering one is a migration (out of
  // scope). Until that session, the gate keys on ownership — see
  // docs/GO-LIVE.md (Session 8, Lane B).
  const showFeedback = membershipRole === "owner";

  // First Light content is fetched only while the pill lives — a retired (or
  // pre-First-Light) business pays nothing for it (decision 83).
  let firstLightSlot: ReactNode = null;
  if (!firstLight.retired && !firstLight.absent) {
    const [template, config] = await Promise.all([getTemplateContent(), getBusinessConfig()]);
    const settings = config.settings;
    const confirmedRaw = (settings.basics_confirmed ?? {}) as Record<
      string,
      { provenance?: string }
    >;
    const basics: FirstLightBasicsProp = {
      name: config.name,
      values: {
        regulated_status: typeof settings.regulated_status === "string" ? settings.regulated_status : "",
        address: typeof settings.address === "string" ? settings.address : "",
        business_hours: typeof settings.business_hours === "string" ? settings.business_hours : "",
        languages: typeof settings.languages === "string" ? settings.languages : "",
      },
      quietHours:
        settings.quiet_hours && typeof settings.quiet_hours === "object"
          ? (settings.quiet_hours as { start: string; end: string })
          : null,
      confirmed: Object.fromEntries(
        Object.entries(confirmedRaw).map(([k, v]) => [
          k,
          v?.provenance ? `Confirmed — ${v.provenance}` : "Confirmed — on The Record",
        ])
      ),
    };
    firstLightSlot = (
      <FirstLight
        state={firstLight}
        template={
          template
            ? {
                displayName: template.displayName,
                version: template.version,
                regulatedStatusOptions: template.regulatedStatusOptions,
                noGoRules: template.noGoRules,
                knowledgePackCategories: template.knowledgePackCategories,
                quietHoursDefault: template.quietHoursDefault,
                standardKeys: template.standardKeys,
              }
            : null
        }
        basics={basics}
      />
    );
  }

  return (
    <AppShell
      businessName={business.name}
      userName={actor.display_name}
      userRole={membershipRole}
      inboxCount={inboxCount}
      taskCount={taskCount}
      showFeedback={showFeedback}
      firstLight={firstLightSlot}
    >
      {children}
    </AppShell>
  );
}
