import Link from "next/link";
import { Paperclip } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { PageHead } from "@/components/shell/page-head";
import { formatWhen } from "@/lib/format";
import { getBusinessFiles, type BusinessFileRow } from "@/lib/server/queries";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

/*
 * The Files surface — Session 26 (C3, founder-ordered): the business's
 * stored files (booklets, guide documents, attachments) listed in ONE
 * read-only surface. No upload, no delete — the doors that write files stay
 * where they are (Settings → Knowledge, the drafting engine); a control that
 * cannot act is never offered (decision 116), so none are drawn.
 *
 * JUDGMENT: the master mockup carries no Files screen — placement follows
 * its spirit: a quiet register listing under the Think section (files are
 * material the firm keeps, like Notes), windowed per the 5e read law.
 */

function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

function UploaderTag({ file }: { file: BusinessFileRow }) {
  // The Record's actor-chip vocabulary (semantic law): gold = Light's hand,
  // red = a human's, source = platform machinery.
  if (file.uploadedByType === "human") {
    return <Badge variant="red">{file.uploadedByName}</Badge>;
  }
  if (file.uploadedByType === "agent") {
    return <Badge variant="gold">✦ {file.uploadedByName}</Badge>;
  }
  return <Badge variant="source">{file.uploadedByName}</Badge>;
}

function FileRow({ file }: { file: BusinessFileRow }) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5 border-b border-rule px-3.5 py-3 last:border-b-0 max-[640px]:grid-cols-1">
      <div className="min-w-0">
        <p className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-ink">
          <Paperclip className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
          <span className="min-w-0 break-all">{file.filename}</span>
        </p>
        <p className="mt-1 font-mono text-[10.5px] tracking-wide text-ink-faint">
          {file.mimeType} · {sizeLabel(file.sizeBytes)}
          {file.linkedTo.length > 0 ? ` · rides: ${file.linkedTo.join(", ")}` : " · not linked to anything yet"}
        </p>
      </div>
      <div className="flex items-center gap-2 justify-self-end max-[640px]:justify-self-start">
        <span className="font-mono text-[10.5px] text-ink-faint">{formatWhen(file.uploadedAt)}</span>
        <UploaderTag file={file} />
      </div>
    </div>
  );
}

export default async function FilesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const params = await searchParams;
  const files = await getBusinessFiles(Number(params.page ?? "1"));

  return (
    <>
      <PageHead
        title="Files"
        sub="Everything the business stores — booklets, guide documents, attachments. Read-only: files are added and managed where they are used"
      />
      {files.rows.length > 0 ? (
        <section className="glass overflow-hidden rounded-xl">
          {files.rows.map((file) => (
            <FileRow key={file.id} file={file} />
          ))}
        </section>
      ) : (
        <div className="glass rounded-xl border-dashed p-8 text-center font-mono text-xs tracking-wide text-ink-faint uppercase">
          No files stored yet — booklets and attachments appear here as they arrive
        </div>
      )}
      {files.total > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-[10.5px] tracking-wide text-ink-faint uppercase">
          <span>
            page {files.page} of {files.pageCount} · {files.total} file
            {files.total === 1 ? "" : "s"}
          </span>
          {files.page > 1 ? (
            <Link
              href={`/files?page=${files.page - 1}`}
              className={cn("min-h-9 content-center text-accent hover:underline")}
            >
              ← previous
            </Link>
          ) : null}
          {files.page < files.pageCount ? (
            <Link
              href={`/files?page=${files.page + 1}`}
              className={cn("min-h-9 content-center text-accent hover:underline")}
            >
              next →
            </Link>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
