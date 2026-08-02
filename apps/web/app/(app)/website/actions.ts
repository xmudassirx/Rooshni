"use server";

import { createHash, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createServiceClient, emitEvent, FILES_BUCKET, storageSlug } from "@rooshni/db";

import { getAppContext } from "@/lib/server/context";
import { isUuid } from "@/lib/server/queries";

/*
 * Session 23 (WS4j, founder-reported) — the featured-image card goes real:
 * Upload and attach-from-library, inline. The storage shape is the s19
 * route-guide pattern exactly (bytes in the private Supabase `files` bucket
 * via the service client; files + file_links rows under the caller's own
 * RLS; replacement archives the old file SOFTLY — never deleted; evented).
 *
 * JUDGMENT: decision 59 names R2 as images' eventual home (zero egress).
 * No R2 integration exists and minting one is a new external service (Lane
 * C-5), so the featured image rides the EXISTING lawful store for now —
 * recorded here and in the close report, not silently deviated. Generate
 * stays disabled until a media provider is connected.
 *
 * JUDGMENT: alt text lives in the page row's attributes
 * (attributes.featured_image = { file_id, alt }) — the decision 69 class of
 * additive attributes fill; files/file_links carry no attributes column.
 */

export interface FeaturedImageState {
  error: string | null;
  saved?: boolean;
}

const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

async function setFeaturedImage(
  pageId: string,
  fileId: string,
  alt: string,
  note: string
): Promise<FeaturedImageState> {
  const { db, business, actor } = await getAppContext();

  const { data: page, error: pageError } = await db
    .from("content_items")
    .select("id, attributes")
    .eq("id", pageId)
    .eq("business_id", business.id)
    .is("archived_at", null)
    .maybeSingle();
  if (pageError) return { error: `Page lookup failed: ${pageError.message}` };
  if (!page) return { error: "That page no longer exists." };

  // Replacement retires the previous featured file SOFTLY (the s19 shape:
  // archived, never deleted; readers take the newest live file).
  const { data: oldLinks } = await db
    .from("file_links")
    .select("file_id")
    .eq("entity_type", "content_item")
    .eq("entity_id", pageId)
    .eq("role", "featured_image");
  const oldFileIds = (oldLinks ?? []).map((l) => l.file_id).filter((f) => f !== fileId);
  if (oldFileIds.length) {
    await db.from("files").update({ archived_at: new Date().toISOString() }).in("id", oldFileIds);
  }

  const { error: linkError } = await db.from("file_links").insert({
    business_id: business.id,
    file_id: fileId,
    entity_type: "content_item",
    entity_id: pageId,
    role: "featured_image",
  });
  if (linkError) return { error: `File link failed: ${linkError.message}` };

  const attrs = (page.attributes ?? {}) as Record<string, unknown>;
  const { error: attrError } = await db
    .from("content_items")
    .update({ attributes: { ...attrs, featured_image: { file_id: fileId, alt } } })
    .eq("id", pageId)
    .eq("business_id", business.id);
  if (attrError) return { error: `Saving the alt text failed: ${attrError.message}` };

  await emitEvent(db, {
    business_id: business.id,
    actor_id: actor.id,
    action: "content.featured_image_set",
    entity_type: "content_item",
    entity_id: pageId,
    payload: {
      file_id: fileId,
      alt,
      note,
      ...(oldFileIds.length ? { replaced_file_ids: oldFileIds } : {}),
    },
  });

  revalidatePath(`/website/${pageId}`);
  return { error: null, saved: true };
}

/** Upload a new image and set it as the page's featured image. */
export async function uploadFeaturedImageAction(
  _prev: FeaturedImageState,
  formData: FormData
): Promise<FeaturedImageState> {
  const pageId = String(formData.get("pageId") ?? "");
  const alt = String(formData.get("alt") ?? "").trim();
  const raw = formData.get("image");
  if (!isUuid(pageId)) return { error: "No page was selected." };
  if (!(raw instanceof File) || raw.size === 0) return { error: "Choose an image first." };
  if (!alt) return { error: "Alt text is required — it is written in the same act as the image." };
  const ext = IMAGE_TYPES[raw.type];
  if (!ext) return { error: "Images only — JPEG, PNG, WebP or GIF." };
  if (raw.size > IMAGE_MAX_BYTES) {
    return { error: "The image exceeds the 8MB ceiling — resize it and try again." };
  }

  const { db, business, actor } = await getAppContext();

  const service = createServiceClient();
  const { error: bucketError } = await service.storage.createBucket(FILES_BUCKET, { public: false });
  if (bucketError && !/exist/i.test(bucketError.message)) {
    return { error: `Storage bucket unavailable: ${bucketError.message}` };
  }
  const bytes = Buffer.from(await raw.arrayBuffer());
  // WS5c (Session 23): human slug prefix + uuid — eye-findable, collision-proof.
  const storageKey = `featured-images/${business.id}/${storageSlug(raw.name)}-${randomUUID()}.${ext}`;
  const { error: uploadError } = await service.storage
    .from(FILES_BUCKET)
    .upload(storageKey, bytes, { contentType: raw.type });
  if (uploadError) return { error: `Upload failed: ${uploadError.message}` };

  const { data: fileRow, error: fileError } = await db
    .from("files")
    .insert({
      business_id: business.id,
      storage_key: storageKey,
      filename: raw.name,
      mime_type: raw.type,
      size_bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      uploaded_by: actor.id,
    })
    .select("id")
    .single();
  if (fileError) return { error: `File record failed: ${fileError.message}` };

  return setFeaturedImage(pageId, fileRow.id as string, alt, "featured image uploaded");
}

/** Attach an EXISTING library image as the page's featured image. */
export async function attachFeaturedFromLibraryAction(
  _prev: FeaturedImageState,
  formData: FormData
): Promise<FeaturedImageState> {
  const pageId = String(formData.get("pageId") ?? "");
  const fileId = String(formData.get("fileId") ?? "");
  const alt = String(formData.get("alt") ?? "").trim();
  if (!isUuid(pageId) || !isUuid(fileId)) return { error: "Pick an image from the library first." };
  if (!alt) return { error: "Alt text is required — it is written in the same act as the image." };

  const { db, business } = await getAppContext();
  const { data: file, error } = await db
    .from("files")
    .select("id, mime_type")
    .eq("id", fileId)
    .eq("business_id", business.id)
    .is("archived_at", null)
    .maybeSingle();
  if (error) return { error: `Library lookup failed: ${error.message}` };
  if (!file) return { error: "That file no longer exists." };
  if (!IMAGE_TYPES[file.mime_type as string]) return { error: "Only images can be featured." };

  return setFeaturedImage(pageId, fileId, alt, "featured image attached from library");
}
