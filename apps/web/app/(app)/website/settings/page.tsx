import { PageHead } from "@/components/shell/page-head";
import { getDomains } from "@/lib/server/queries";

import { WebsiteSettingsClient } from "./settings-client";

export const dynamic = "force-dynamic";

export default async function WebsiteSettingsPage() {
  const domains = await getDomains();

  return (
    <>
      <PageHead
        title="Website"
        sub="The site's standing configuration — shared by every page, changed only through the gate"
      />
      <WebsiteSettingsClient domains={domains} />
    </>
  );
}
