import { PageHead } from "@/components/shell/page-head";
import { getAppContext } from "@/lib/server/context";

import { MemoryClient } from "./memory-client";

export const dynamic = "force-dynamic";

export default async function MemoryPage() {
  const { business } = await getAppContext();

  return (
    <>
      <PageHead
        title="Light's Memory"
        sub="Everything Light believes — nothing hidden, everything editable"
      />
      <MemoryClient businessName={business.name} />
    </>
  );
}
