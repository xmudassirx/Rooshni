import { PageHead } from "@/components/shell/page-head";
import { getAgentActor, getEnquiryOptions, getTasks } from "@/lib/server/queries";

import { TasksClient } from "./tasks-client";

export const dynamic = "force-dynamic";

export default async function TasksPage() {
  const [tasks, enquiries, agent] = await Promise.all([
    getTasks(),
    getEnquiryOptions(),
    getAgentActor(),
  ]);

  return (
    <>
      <PageHead
        title="Tasks"
        sub="Yours — the Approval Inbox is where Light waits for you; this is what the week wants from you"
      />
      <TasksClient tasks={tasks} enquiries={enquiries} agent={agent} />
    </>
  );
}
