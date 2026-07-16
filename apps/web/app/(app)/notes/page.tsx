import { PageHead } from "@/components/shell/page-head";
import { getNotes } from "@/lib/server/queries";

import { NotesClient } from "./notes-client";

export const dynamic = "force-dynamic";

export default async function NotesPage() {
  const data = await getNotes();

  return (
    <>
      <PageHead
        title="Notes"
        sub="No folders, ever — structure is generated from links and grants"
      />
      <NotesClient data={data} />
    </>
  );
}
