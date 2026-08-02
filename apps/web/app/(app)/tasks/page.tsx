import { PageHead } from "@/components/shell/page-head";
import {
  getAgentActor,
  getEnquiryOptions,
  getIsManager,
  getOpenTaskCount,
  getTasks,
} from "@/lib/server/queries";

import { TasksClient } from "./tasks-client";

export const dynamic = "force-dynamic";

export default async function TasksPage() {
  // WS4c (Session 23): the header states the open-task count — a COUNT
  // aggregate (5e law), the same truth the sidebar badge reads.
  const [tasks, enquiries, agent, openCount, isManager] = await Promise.all([
    getTasks(),
    getEnquiryOptions(),
    getAgentActor(),
    getOpenTaskCount(),
    getIsManager(),
  ]);

  return (
    <>
      <PageHead
        title="Tasks"
        sub={`${openCount} open task${openCount === 1 ? "" : "s"} — the Approval Inbox is where Light waits for you; this is what the week wants from you`}
      />
      <TasksClient tasks={tasks} enquiries={enquiries} agent={agent} isManager={isManager} />
    </>
  );
}
