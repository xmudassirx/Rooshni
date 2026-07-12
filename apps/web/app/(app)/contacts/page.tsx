import { PageHead } from "@/components/shell/page-head";
import { getContacts } from "@/lib/server/queries";

import { ContactsList } from "./contacts-list";

export const dynamic = "force-dynamic";

export default async function ContactsPage() {
  const contacts = await getContacts();

  return (
    <>
      <PageHead
        title="Contacts"
        sub="People and organisations in one book — channels and consents per person, GDPR at the door"
      />
      <ContactsList contacts={contacts} />
    </>
  );
}
