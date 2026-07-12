import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { formatWhen } from "@/lib/format";
import { getContactDetail } from "@/lib/server/queries";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

/*
 * Contact detail — identity, channels with per-channel consent, connected
 * enquiries and relationships. Linked both ways with enquiry detail, and
 * onwards to the Record for this contact's entries. Read-only.
 */

function channelLabel(channel: string): string {
  if (channel === "whatsapp") return "WhatsApp";
  if (channel === "sms") return "SMS";
  return channel.replace(/^./, (c) => c.toUpperCase());
}

function KvRow({ k, v, sub }: { k: string; v: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="flex gap-2.5 text-[13px]">
      <span className="w-26 shrink-0 pt-0.5 font-mono text-[10.5px] tracking-wide text-ink-faint uppercase">
        {k}
      </span>
      <span className="min-w-0 font-medium">
        {v}
        {sub ? <span className="block text-[11.5px] font-normal text-ink-soft">{sub}</span> : null}
      </span>
    </div>
  );
}

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const contact = await getContactDetail(id);
  if (!contact) notFound();

  const junk = contact.status === "junk";
  const firstTouch = contact.firstTouch ?? {};
  const source = typeof firstTouch.source === "string" ? firstTouch.source : null;

  return (
    <>
      <div className="mb-3.5">
        <Link
          href="/contacts"
          className="font-mono text-xs font-semibold tracking-wide text-ink-soft hover:text-ink"
        >
          ← Back to Contacts
        </Link>
      </div>

      <div className="glass rounded-xl p-5">
        <div className="flex flex-wrap items-start gap-3.5">
          <div>
            <h1 className="font-display text-[22px] font-extrabold tracking-tight">
              {contact.name}
            </h1>
            <div
              className={cn(
                "mt-0.5 font-mono text-xs font-semibold uppercase",
                junk ? "text-stamp" : "text-ledger"
              )}
            >
              {contact.type} · {contact.status.replace(/_/g, " ")} · {contact.locale}
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {source ? (
              <Badge variant="source">{source === "meta" ? "Meta lead form" : source}</Badge>
            ) : null}
            <Link
              href={`/record?entity_type=contact&entity_id=${contact.id}`}
              className="font-mono text-[11px] font-semibold tracking-wide text-ledger uppercase hover:underline"
            >
              View on the Record →
            </Link>
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 items-start gap-4 max-[980px]:grid-cols-1">
        <div className="flex flex-col gap-4">
          <Panel title="Identity">
            <div className="flex flex-col gap-2.5 px-4 py-3.5">
              {contact.givenName ? (
                <KvRow
                  k="Name"
                  v={`${contact.givenName}${contact.familyName ? ` ${contact.familyName}` : ""}`}
                />
              ) : null}
              {contact.orgId ? (
                <KvRow
                  k="Organisation"
                  v={
                    <Link href={`/contacts/${contact.orgId}`} className="hover:underline">
                      {contact.orgName ?? "View organisation"}
                    </Link>
                  }
                />
              ) : null}
              <KvRow k="Status" v={contact.status.replace(/_/g, " ")} />
              <KvRow k="Locale" v={contact.locale} />
              <KvRow
                k="First seen"
                v={formatWhen(contact.createdAt)}
                sub={
                  source
                    ? `arrived via ${source === "meta" ? "a Meta lead form" : source}${
                        typeof firstTouch.campaign_id === "string"
                          ? ` · campaign ${firstTouch.campaign_id}`
                          : ""
                      }`
                    : undefined
                }
              />
            </div>
          </Panel>

          <Panel title="Channels & consent — consent is per channel, by law">
            <div className="flex flex-col gap-2 px-3 py-3">
              {contact.channels.map((channel) => {
                const kinds = ["transactional", "marketing"].filter(
                  (k) => channel.consent[k] === true
                );
                const grantedAt =
                  typeof channel.consent.granted_at === "string"
                    ? channel.consent.granted_at
                    : null;
                const consentSource =
                  typeof channel.consent.source === "string" ? channel.consent.source : null;
                return (
                  <div
                    key={`${channel.channel}-${channel.value}`}
                    className="glass rounded-lg px-3 py-2.5"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-[10.5px] font-semibold tracking-wide text-ink uppercase">
                        {channelLabel(channel.channel)}
                      </span>
                      <span className="text-[12.5px] font-medium">{channel.value}</span>
                      {channel.isPrimary ? <Badge variant="time">primary</Badge> : null}
                      {kinds.length ? (
                        kinds.map((kind) => (
                          <Badge key={kind} variant="green">
                            ✓ {kind}
                          </Badge>
                        ))
                      ) : (
                        <Badge variant="pending">no consent recorded</Badge>
                      )}
                    </div>
                    {grantedAt ? (
                      <div className="mt-1 font-mono text-[10px] tracking-wide text-ink-faint uppercase">
                        granted via {(consentSource ?? "unknown").replace(/_/g, " ")} ·{" "}
                        {formatWhen(grantedAt)}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {contact.channels.length === 0 ? (
                <div className="py-4 text-center font-mono text-[10px] tracking-wide text-ink-faint uppercase">
                  No channels on file yet
                </div>
              ) : null}
            </div>
          </Panel>
        </div>

        <div className="flex flex-col gap-4">
          <Panel title="Connected enquiries">
            <div className="flex flex-col gap-2 px-3 py-3">
              {contact.enquiries.map((enquiry) => (
                <Link
                  key={`${enquiry.id}-${enquiry.role}`}
                  href={`/enquiries/${enquiry.id}`}
                  className="glass block rounded-lg px-3 py-2.5 transition-colors hover:border-ledger"
                >
                  <div className="text-[13px] font-bold">{enquiry.title}</div>
                  <div className="mt-px font-mono text-[10.5px] font-semibold text-ledger">
                    {enquiry.visaRoute ?? "Route not yet classified"}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {enquiry.stageLabel ? (
                      <Badge
                        variant={
                          enquiry.terminalOutcome === "won"
                            ? "green"
                            : enquiry.isTerminal
                              ? "red"
                              : "time"
                        }
                      >
                        {enquiry.stageLabel}
                      </Badge>
                    ) : null}
                    <Badge variant="time">as {enquiry.role.replace(/_/g, " ")}</Badge>
                    <Badge variant="time">since {formatWhen(enquiry.stageEnteredAt)}</Badge>
                  </div>
                </Link>
              ))}
              {contact.enquiries.length === 0 ? (
                <div className="py-4 text-center font-mono text-[10px] tracking-wide text-ink-faint uppercase">
                  No enquiries connect to this contact
                </div>
              ) : null}
            </div>
          </Panel>

          <Panel title="Relationships">
            <div className="flex flex-col gap-2 px-3 py-3">
              {contact.relationships.map((rel) => (
                <Link
                  key={`${rel.contactId}-${rel.relationship}-${rel.direction}`}
                  href={`/contacts/${rel.contactId}`}
                  className="glass flex flex-wrap items-center gap-2 rounded-lg px-3 py-2.5 transition-colors hover:border-ledger"
                >
                  <span className="text-[13px] font-bold">{rel.name}</span>
                  <span className="font-mono text-[10px] tracking-wide text-ink-faint uppercase">
                    {rel.direction === "out"
                      ? `this contact is their ${rel.relationship.replace(/_/g, " ")}`
                      : `their ${rel.relationship.replace(/_/g, " ")}`}
                  </span>
                </Link>
              ))}
              {contact.relationships.length === 0 ? (
                <div className="py-4 text-center font-mono text-[10px] tracking-wide text-ink-faint uppercase">
                  No recorded relationships
                </div>
              ) : null}
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
