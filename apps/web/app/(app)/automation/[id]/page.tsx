import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHead } from "@/components/shell/page-head";
import { HonestButton } from "@/components/ui/honest-button";
import { getWorkflowDetail } from "@/lib/server/queries";
import { workflowTitle } from "@/lib/workflow-language";

import { WorkflowDetailClient } from "./wf-detail-client";

export const dynamic = "force-dynamic";

export default async function WorkflowDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const wf = await getWorkflowDetail(id);
  if (!wf) notFound();

  return (
    <>
      <div className="mb-3.5">
        <Link
          href="/automation"
          className="font-mono text-xs font-semibold tracking-wide text-ink-soft hover:text-ink"
        >
          ← Back to Automation
        </Link>
      </div>
      <PageHead
        title={workflowTitle(wf.key)}
        sub={`v${wf.version} · ${wf.status.toUpperCase()} · this canvas is generated from the workflow data — nothing to keep in sync`}
        actions={
          <>
            <HonestButton notice="Test mode runs the flow against a dummy enquiry — every step evented, nothing sent. It arrives with the send-pipeline session.">
              Test workflow
            </HonestButton>
            <HonestButton
              variant="primary"
              notice="Publishing a change is a Level 3 configuration change — it goes to your Approval Inbox first, in plain English. Editing arrives with its session."
            >
              Publish changes
            </HonestButton>
          </>
        }
      />
      <WorkflowDetailClient wf={wf} />
    </>
  );
}
