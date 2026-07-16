import { PageHead } from "@/components/shell/page-head";

import { TemplatesActions, TemplatesClient } from "./templates-client";

export default function WebsiteTemplatesPage() {
  return (
    <>
      <PageHead
        title="Website"
        sub="Templates — shell-wide gallery: every business sees these, yours and the marketplace's"
        actions={<TemplatesActions />}
      />
      <TemplatesClient />
    </>
  );
}
