import Link from "next/link";
import { notFound } from "next/navigation";

import { HonestButton } from "@/components/ui/honest-button";
import { formatWhen } from "@/lib/format";
import { getWebsitePageDetail } from "@/lib/server/queries";

export const dynamic = "force-dynamic";

/*
 * view-wspage, master mockup v2: the page body with its sticky rail —
 * Publish, Scorecard, Featured image, Organisation, Schema. Editing, the
 * scorecard radar's numbers, tags and schema attachments arrive with the
 * website-content session; every card states its own honest not-yet.
 */

function RailCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="glass rounded-xl px-4 py-3.5">
      <div className="mb-2.5 font-mono text-[9.5px] font-bold tracking-[.14em] text-ink-faint uppercase">
        {title}
      </div>
      {children}
    </div>
  );
}

function RailRow({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1 text-[12.5px]">
      <span className="text-ink-soft">{k}</span>
      <b className="text-xs">{v}</b>
    </div>
  );
}

export default async function WebsitePageDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const page = await getWebsitePageDetail(id);
  if (!page || page.contentType === "note") notFound();

  return (
    <>
      <div className="mb-3.5">
        <Link
          href="/website"
          className="font-mono text-xs font-semibold tracking-wide text-ink-soft hover:text-ink"
        >
          ← Back to Pages
        </Link>
      </div>
      <div className="grid grid-cols-[1fr_320px] items-start gap-4 max-[1000px]:grid-cols-1">
        <div className="glass rounded-xl px-5.5 py-5">
          <h1 className="font-display text-2xl font-extrabold">{page.title}</h1>
          <div className="mt-1.5 mb-3.5 font-mono text-[11px] text-ink-faint">
            /<b className="text-ink-soft">{page.slug}</b>
          </div>
          <div className="sticky top-0 z-5 flex flex-wrap items-center gap-1 rounded-lg border border-rule bg-paper-deep p-1.5">
            {["H2", "H3", "B", "I", "•≡", "”", "⛓", "+ Block", "▣ Image", "</>"].map((b) => (
              <span
                key={b}
                title="Editing arrives with the website-content session"
                className="flex h-7.5 min-w-8 cursor-not-allowed items-center justify-center rounded-md px-2 text-[12.5px] font-semibold text-ink-faint"
              >
                {b}
              </span>
            ))}
            <span className="mx-1 h-4.5 w-px bg-rule" />
            <span className="light-text flex h-7.5 items-center px-2 font-mono text-[11px] font-bold">
              ✦ Light
            </span>
          </div>
          <div className="min-h-60 px-1 py-4.5 text-sm leading-[1.75]">
            {page.blocks.length ? (
              page.blocks.map((b, i) => (
                <p key={i} className="mb-2.5">
                  {b.text}
                </p>
              ))
            ) : (
              <p className="text-ink-faint">
                No body yet — structured blocks land here; the editor and its
                Light briefing arrive with the website-content session.
              </p>
            )}
          </div>
        </div>

        <div className="sticky top-3 flex flex-col gap-3">
          <RailCard title="Publish">
            <RailRow
              k="Status"
              v={
                page.state === "published" ? (
                  <span className="rounded bg-ledger px-1.5 py-0.5 font-mono text-[9.5px] font-bold text-white uppercase">
                    Published
                  </span>
                ) : (
                  <span className="rounded border border-rule bg-paper-deep px-1.5 py-0.5 font-mono text-[9.5px] font-bold text-ink-soft uppercase">
                    {page.state.replace(/_/g, " ")}
                  </span>
                )
              }
            />
            <RailRow k="Version" v={`v${page.version}`} />
            <RailRow k="Last touched" v={formatWhen(page.updatedAt)} />
            {page.publishedAt ? (
              <RailRow
                k="Published"
                v={`${formatWhen(page.publishedAt)}${page.publishedByName ? ` · ${page.publishedByName}` : ""}`}
              />
            ) : null}
            <HonestButton
              variant="primary"
              className="mt-2.5 block [&>button]:w-full"
              notice="Publishing is Level 3 — the draft lands in your Approval Inbox with a diff. The publish pipeline arrives with its session."
            >
              Publish update
            </HonestButton>
          </RailCard>

          <RailCard title="Scorecard · SEO / GEO / AEO / FRESH / COMP">
            <p className="text-[12.5px] text-ink-soft">
              Not yet scored — the five-axis radar draws from real audits, and
              no audit has run. Scoring arrives with the website-content
              session; an empty card is the truth.
            </p>
          </RailCard>

          <RailCard title="Featured image">
            <p className="text-[12.5px] text-ink-soft">
              None yet — upload, library, or ✦ generate to the brand tokens; alt
              text is written in the same act, and a missing alt blocks the
              stamp.
            </p>
          </RailCard>

          <RailCard title="Organisation">
            <p className="text-[12.5px] text-ink-soft">
              No category or tags yet. Light attaches tags from the curated
              library with a stated reason — the library arrives with its
              session.
            </p>
          </RailCard>

          <RailCard title="Schema">
            <p className="text-[12.5px] text-ink-soft">
              Attached by archetype, editable per page, validated on publish —
              errors block the stamp. No schema yet: this page has no archetype.
            </p>
          </RailCard>
        </div>
      </div>
    </>
  );
}
