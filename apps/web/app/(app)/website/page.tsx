import { PageHead } from "@/components/shell/page-head";
import { getWebsitePages } from "@/lib/server/queries";

import { WebsiteClient } from "./website-client";

export const dynamic = "force-dynamic";

export default async function WebsitePage() {
  const pages = await getWebsitePages();

  return (
    <>
      <PageHead
        title="Website"
        sub="Site, funnels, blog and forms — one surface, every publish your stamp"
      />
      <WebsiteClient pages={pages} />
    </>
  );
}
