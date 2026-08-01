import Link from "next/link";
import { PageHead } from "@/components/shell/page-head";
import { getContacts } from "@/lib/server/queries";
import { cn } from "@/lib/utils";

import { ContactsList } from "./contacts-list";

export const dynamic = "force-dynamic";

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const params = await searchParams;
  // WS5d (Session 22): the book reads a window — default 20, counted by
  // aggregate; hydration is scoped to the page's contacts only.
  const contacts = await getContacts(Number(params.page ?? "1"));

  return (
    <>
      <PageHead
        title="Contacts"
        sub="People and organisations in one book — channels and consents per person, GDPR at the door"
      />
      <ContactsList contacts={contacts.rows} />
      {contacts.total > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-[10.5px] tracking-wide text-ink-faint uppercase">
          <span>
            page {contacts.page} of {contacts.pageCount} · {contacts.total} contact
            {contacts.total === 1 ? "" : "s"}
          </span>
          {contacts.page > 1 ? (
            <Link
              href={`/contacts?page=${contacts.page - 1}`}
              className={cn("min-h-9 content-center text-accent hover:underline")}
            >
              ← previous
            </Link>
          ) : null}
          {contacts.page < contacts.pageCount ? (
            <Link
              href={`/contacts?page=${contacts.page + 1}`}
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
