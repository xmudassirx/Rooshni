import { loadEnv } from "./env";
import { createServiceClient } from "../src/client";

/**
 * Bind a Facebook Page to a business for the Meta Lead Forms webhook
 * (Session 10). The webhook resolves the tenant by
 * businesses.settings.meta.page_id — exactly one business per page.
 *
 *   npm run wire-meta --workspace=@rooshni/db -- <page_id> [business_id]
 *
 * With one business in the database the id can be omitted. Config, not a
 * secret — the page id is public on the Page itself.
 */
async function main() {
  loadEnv();
  const [pageId, businessArg] = process.argv.slice(2).filter((a) => a !== "--");
  if (!pageId || !/^\d+$/.test(pageId)) {
    console.error("Usage: npm run wire-meta --workspace=@rooshni/db -- <numeric page_id> [business_id]");
    process.exit(1);
  }

  const db = createServiceClient();
  const { data: businesses, error } = await db
    .from("businesses")
    .select("id, name, settings")
    .is("archived_at", null);
  if (error) throw new Error(`business lookup failed: ${error.message}`);
  const target = businessArg
    ? businesses?.find((b) => b.id === businessArg)
    : businesses?.length === 1
      ? businesses[0]
      : undefined;
  if (!target) {
    console.error(
      businessArg
        ? `Business ${businessArg} not found.`
        : `${businesses?.length ?? 0} businesses exist — name one: npm run wire-meta -- <page_id> <business_id>`
    );
    for (const b of businesses ?? []) console.error(`  ${b.id}  ${b.name}`);
    process.exit(1);
  }

  const settings = (target.settings ?? {}) as Record<string, unknown>;
  const meta = { ...((settings.meta as Record<string, unknown>) ?? {}), page_id: pageId };
  const { error: updateError } = await db
    .from("businesses")
    .update({ settings: { ...settings, meta } })
    .eq("id", target.id);
  if (updateError) throw new Error(`settings update failed: ${updateError.message}`);
  console.log(`Bound page ${pageId} → business "${target.name}" (${target.id}).`);
}

main().catch((err) => {
  console.error("wire-meta failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
