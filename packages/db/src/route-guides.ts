import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Route-guide documents (Session 19, founder pre-ruling PR-i).
 *
 * A guide is a KNOWLEDGE ENTRY WITH A FILE: a content_items row of the
 * template-declared kind `route_guide` (knowledge_category vocabulary,
 * 0032), route-scoped via attributes.visa_route, linked through file_links
 * to a files row whose bytes live in Supabase Storage under
 * files.storage_key. One door: Settings → Knowledge.
 *
 * The drafting engine attaches the route-matched guide to the intro email
 * ONLY when one is PUBLISHED — no guide published means no attachment,
 * never a placeholder. The ATTACHMENTS pre-flight (0032) verifies existence,
 * linkage and the 8MB ceiling before the stamp.
 *
 * JUDGMENT: guide BYTES live in a private Supabase Storage bucket under
 * files.storage_key — 0011 always pointed at a storage backend, the same
 * project holds it (no new service, no new credential), and decision 59's
 * "Supabase stores rows, not media" is read as governing media-model
 * video/images (its own rationale), not firm documents ("immigration
 * casework is document-heavy from day one", 0011). Flagged at pre-flight;
 * awaiting sign-off at close.
 */

/** The ruled size ceiling — refuse anything over it, visibly (PR-i). */
export const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;

/** The one storage bucket for firm documents; keys come from
 * files.storage_key. Private — bytes leave only as mail attachments. */
export const FILES_BUCKET = "files";

export interface RouteGuideFile {
  id: string;
  storage_key: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
}

export interface RouteGuide {
  content_item_id: string;
  title: string;
  visa_route: string;
  file: RouteGuideFile;
}

/**
 * The PUBLISHED guide for the first matching route, with its live linked
 * file. Routes are tried in the caller's priority order (the enquiry's
 * declared route first, then the lead-text matches). Returns null when no
 * published guide with a live, size-sane file exists — the honest nothing.
 */
export async function findPublishedRouteGuide(
  db: SupabaseClient,
  businessId: string,
  routes: string[]
): Promise<RouteGuide | null> {
  const wanted = [...new Set(routes.filter(Boolean))];
  if (!wanted.length) return null;

  const { data: entries, error } = await db
    .from("content_items")
    .select("id, title, attributes")
    .eq("business_id", businessId)
    .eq("content_type", "knowledge_entry")
    .eq("state", "published")
    .is("archived_at", null);
  if (error) throw new Error(`route guide lookup failed: ${error.message}`);

  const guides = (entries ?? []).flatMap((row) => {
    const attrs = (row.attributes ?? {}) as Record<string, unknown>;
    if (attrs.knowledge_category !== "route_guide") return [];
    const route = typeof attrs.visa_route === "string" ? attrs.visa_route : null;
    if (!route || !wanted.includes(route)) return [];
    return [{ id: row.id as string, title: row.title as string, route }];
  });
  if (!guides.length) return null;

  for (const route of wanted) {
    for (const guide of guides.filter((g) => g.route === route)) {
      const { data: links, error: linkError } = await db
        .from("file_links")
        .select("file_id, created_at")
        .eq("entity_type", "content_item")
        .eq("entity_id", guide.id)
        .eq("role", "attachment")
        .order("created_at", { ascending: false });
      if (linkError) throw new Error(`route guide link lookup failed: ${linkError.message}`);
      for (const link of links ?? []) {
        const { data: file, error: fileError } = await db
          .from("files")
          .select("id, storage_key, filename, mime_type, size_bytes")
          .eq("id", link.file_id)
          .is("archived_at", null)
          .maybeSingle();
        if (fileError) throw new Error(`route guide file lookup failed: ${fileError.message}`);
        if (!file) continue;
        if (Number(file.size_bytes) > ATTACHMENT_MAX_BYTES) continue; // size-sane: never attach over the ceiling
        return {
          content_item_id: guide.id,
          title: guide.title,
          visa_route: route,
          file: {
            id: file.id,
            storage_key: file.storage_key,
            filename: file.filename,
            mime_type: file.mime_type,
            size_bytes: Number(file.size_bytes),
          },
        };
      }
    }
  }
  return null;
}

/** The declared-attachment shape a communication row carries
 * (attributes.attachments — what the 0032 pre-flight verifies and the
 * dispatcher carries). */
export interface DeclaredAttachment {
  file_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  content_item_id?: string;
}

export function declareAttachment(guide: RouteGuide): DeclaredAttachment {
  return {
    file_id: guide.file.id,
    filename: guide.file.filename,
    mime_type: guide.file.mime_type,
    size_bytes: guide.file.size_bytes,
    content_item_id: guide.content_item_id,
  };
}
