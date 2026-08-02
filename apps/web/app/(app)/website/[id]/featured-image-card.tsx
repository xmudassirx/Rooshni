"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  attachFeaturedFromLibraryAction,
  uploadFeaturedImageAction,
  type FeaturedImageState,
} from "../actions";

/*
 * Session 23 (WS4j) — the featured-image card's working controls: Upload
 * and attach-from-library, inline. Generate stays DISABLED until a media
 * provider is connected, honestly labelled (never a stub that pretends).
 */

const INITIAL: FeaturedImageState = { error: null };

export function FeaturedImageCard({
  pageId,
  featured,
  library,
}: {
  pageId: string;
  featured: { fileId: string; filename: string; url: string | null; alt: string } | null;
  library: { id: string; filename: string }[];
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"idle" | "upload" | "library">("idle");
  const [uploadState, uploadAction, uploading] = useActionState(uploadFeaturedImageAction, INITIAL);
  const [attachState, attachAction, attaching] = useActionState(
    attachFeaturedFromLibraryAction,
    INITIAL
  );

  useEffect(() => {
    if (uploadState.saved || attachState.saved) {
      setMode("idle");
      router.refresh();
    }
  }, [uploadState.saved, attachState.saved, router]);

  return (
    <div className="flex flex-col gap-2">
      {featured ? (
        <figure className="overflow-hidden rounded-lg border border-rule">
          {featured.url ? (
            // eslint-disable-next-line @next/next/no-img-element -- a signed,
            // short-lived storage URL; next/image cannot optimise it.
            <img src={featured.url} alt={featured.alt} className="max-h-40 w-full object-cover" />
          ) : null}
          <figcaption className="bg-paper-deep px-2 py-1 font-mono text-[9.5px] tracking-wide text-ink-soft">
            {featured.filename} · alt: {featured.alt || "not set"}
          </figcaption>
        </figure>
      ) : (
        <p className="text-[12.5px] text-ink-soft">None yet.</p>
      )}

      {mode === "idle" ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" onClick={() => setMode("upload")}>
            {featured ? "Replace…" : "Upload…"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMode("library")} disabled={!library.length}>
            From library{library.length ? "" : " (empty)"}
          </Button>
          <span
            title="Generation needs a connected media provider — Settings → Integrations; nothing is connected yet"
            className="cursor-not-allowed rounded-md border border-dashed border-rule px-2 py-1 font-mono text-[10px] tracking-wide text-ink-faint/70 uppercase"
          >
            ✦ Generate — no media provider connected
          </span>
        </div>
      ) : null}

      {mode === "upload" ? (
        <form action={uploadAction} className="flex flex-col gap-2">
          <input type="hidden" name="pageId" value={pageId} />
          <input
            type="file"
            name="image"
            accept="image/jpeg,image/png,image/webp,image/gif"
            required
            className="text-[12px] text-ink-soft file:mr-2 file:rounded-md file:border file:border-rule file:bg-paper file:px-2 file:py-1 file:font-mono file:text-[10.5px] file:text-ink-soft"
          />
          <input
            name="alt"
            required
            placeholder="Alt text — written in the same act, required"
            className="rounded-lg border border-rule bg-paper px-2.5 py-1.5 text-[12.5px] text-ink outline-none placeholder:text-ink-faint focus:outline-2 focus:-outline-offset-1 focus:outline-accent"
          />
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="primary" type="submit" disabled={uploading}>
              {uploading ? "Uploading…" : "Upload & attach"}
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setMode("idle")}>
              Cancel
            </Button>
          </div>
          {uploadState.error ? (
            <p className="text-[12px] text-stamp">{uploadState.error}</p>
          ) : null}
        </form>
      ) : null}

      {mode === "library" ? (
        <form action={attachAction} className="flex flex-col gap-2">
          <input type="hidden" name="pageId" value={pageId} />
          <select
            name="fileId"
            required
            className="rounded-lg border border-rule bg-paper px-2.5 py-1.5 font-mono text-[12px] text-ink"
          >
            <option value="">Pick an image…</option>
            {library.map((f) => (
              <option key={f.id} value={f.id}>
                {f.filename}
              </option>
            ))}
          </select>
          <input
            name="alt"
            required
            placeholder="Alt text — written in the same act, required"
            className="rounded-lg border border-rule bg-paper px-2.5 py-1.5 text-[12.5px] text-ink outline-none placeholder:text-ink-faint focus:outline-2 focus:-outline-offset-1 focus:outline-accent"
          />
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="primary" type="submit" disabled={attaching}>
              {attaching ? "Attaching…" : "Attach"}
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setMode("idle")}>
              Cancel
            </Button>
          </div>
          {attachState.error ? (
            <p className="text-[12px] text-stamp">{attachState.error}</p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
