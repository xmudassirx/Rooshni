import { getKnowledgeEntries, getKnowledgeVocab } from "@/lib/server/queries";
import { EntryTitle, KnowledgeEntryControls, NewEntryButton } from "./knowledge-editor";
import { Badge } from "@/components/ui/badge";

/*
 * Settings → Knowledge (Session 15, PR-1) — the ONE door for the knowledge
 * pack (the one-door law). Entries are content_items rows of type
 * knowledge_entry, grouped under the CATEGORY VOCABULARY the installed
 * template declares (0024 field_definitions.validation.allowed) — never
 * hardcoded chrome. Published entries are what Light's retrieval reads;
 * drafts are invisible to drafting. Every change is evented.
 */

export async function KnowledgeTab() {
  const [vocab, entries] = await Promise.all([getKnowledgeVocab(), getKnowledgeEntries()]);

  if (!vocab) {
    return (
      <div className="glass rounded-xl px-4 py-6 text-center">
        <p className="text-[13px] text-ink-soft">
          No installed template declares a knowledge vocabulary yet — the pack
          arrives with the vertical template.
        </p>
      </div>
    );
  }

  const routeLabel = new Map(vocab.routes.map((r) => [r.key, r.label]));
  const byCategory = new Map<string, typeof entries>();
  for (const entry of entries) {
    const list = byCategory.get(entry.category) ?? [];
    list.push(entry);
    byCategory.set(entry.category, list);
  }

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[12px] text-ink-faint">
          Light drafts from published entries only — task-scoped, never the
          whole pack; the entries a draft used are named on its credit line.
        </p>
        <NewEntryButton vocab={vocab} />
      </div>

      {entries.length === 0 ? (
        <div className="glass rounded-xl px-4 py-8 text-center">
          <p className="text-[13px] text-ink-soft">
            No entries yet — Light drafts from what you put here.
          </p>
          <p className="mt-1 font-mono text-[10px] tracking-wide text-ink-faint uppercase">
            {vocab.categories.map((c) => c.label).join(" · ")}
          </p>
        </div>
      ) : (
        vocab.categories.map((category) => {
          const rows = byCategory.get(category.key) ?? [];
          return (
            <div key={category.key} className="glass mb-3 rounded-xl px-4 py-3">
              <div className="flex items-baseline justify-between border-b border-dashed border-paper-deep pb-2">
                <span className="font-mono text-[10px] font-semibold tracking-[.14em] text-ink-faint uppercase">
                  {category.label}
                </span>
                <span className="font-mono text-[10px] text-ink-faint">
                  {rows.length === 0 ? "empty" : `${rows.length} ${rows.length === 1 ? "entry" : "entries"}`}
                </span>
              </div>
              {rows.length === 0 ? (
                <p className="py-2.5 text-[12px] text-ink-faint">
                  Nothing here yet — Light cannot draft from this category until you add to it.
                </p>
              ) : (
                rows.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-start gap-3 border-b border-dashed border-paper-deep py-2.5 last:border-b-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {/* WS5b (Session 23): the title opens the READ view —
                            editing is no longer the only door. */}
                        <EntryTitle entry={entry} vocab={vocab} />
                        {entry.visaRoute ? (
                          <Badge variant="source">{routeLabel.get(entry.visaRoute) ?? entry.visaRoute}</Badge>
                        ) : null}
                        {entry.state === "published" ? (
                          <Badge variant="green">Published</Badge>
                        ) : (
                          <Badge variant="pending">Draft — invisible to Light</Badge>
                        )}
                        {/* WS5a (Session 23): ANY entry carrying a file wears
                            its attachment chip; a route_guide without one
                            stays visibly incomplete (PR-i). */}
                        {entry.file ? (
                          <Badge variant="source">
                            ⎘ {entry.file.filename} · {(entry.file.sizeBytes / 1024 / 1024).toFixed(1)}MB
                          </Badge>
                        ) : entry.category === "route_guide" ? (
                          <Badge variant="pending">no document — nothing will attach</Badge>
                        ) : null}
                      </div>
                      <p className="mt-1 line-clamp-2 text-[12px] whitespace-pre-wrap text-ink-soft">
                        {entry.bodyText}
                      </p>
                      <p className="mt-1 font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">
                        v{entry.version} · saved{" "}
                        {new Date(entry.updatedAt).toLocaleDateString("en-GB", {
                          day: "numeric",
                          month: "short",
                        })}{" "}
                        · every version retained, every change on The Record
                      </p>
                    </div>
                    <KnowledgeEntryControls entry={entry} vocab={vocab} />
                  </div>
                ))
              )}
            </div>
          );
        })
      )}
    </>
  );
}
