import Link from "next/link";
import { PageHead } from "@/components/shell/page-head";
import { getContacts } from "@/lib/server/queries";
import { cn } from "@/lib/utils";

import { ArchivedToast } from "./archived-toast";
import { ContactsList } from "./contacts-list";

export const dynamic = "force-dynamic";

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string; archived?: string }>;
}) {
  const params = await searchParams;
  // Session 30, Workstream C: the archive action lands here with the
  // archived contact's name — the book shows the once-per-event
  // confirmation; the book itself no longer holds (or links) the contact.
  const archivedName =
    typeof params.archived === "string" ? params.archived.trim().slice(0, 120) : "";
  // WS5d (Session 22): the book reads a window — default 20, counted by
  // aggregate; hydration is scoped to the page's contacts only.
  // Session 28: search reads the ENTIRE set server-side — never just the
  // loaded page; the pagination carries the query.
  const q = typeof params.q === "string" ? params.q.trim().slice(0, 80) : "";
  const contacts = await getContacts(Number(params.page ?? "1"), q);
  const pageHref = (page: number) =>
    `/contacts?${q ? `q=${encodeURIComponent(q)}&` : ""}page=${page}`;

  return (
    <>
      <PageHead
        title="Contacts"
        sub="People and organisations in one book — channels and consents per person, GDPR at the door"
      />
      <ContactsList contacts={contacts.rows} query={q} />
      {archivedName ? <ArchivedToast name={archivedName} /> : null}
      {contacts.total > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-[10.5px] tracking-wide text-ink-faint uppercase">
          <span>
            page {contacts.page} of {contacts.pageCount} · {contacts.total} contact
            {contacts.total === 1 ? "" : "s"}
            {q ? <> matching &ldquo;{q}&rdquo;</> : null}
          </span>
          {contacts.page > 1 ? (
            <Link
              href={pageHref(contacts.page - 1)}
              className={cn("min-h-9 content-center text-accent hover:underline")}
            >
              ← previous
            </Link>
          ) : null}
          {contacts.page < contacts.pageCount ? (
            <Link
              href={pageHref(contacts.page + 1)}
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
