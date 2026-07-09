"use client";

import { useState } from "react";
import Link from "next/link";

import type { ContactListRow } from "@/lib/server/queries";
import { cn } from "@/lib/utils";

/*
 * Signed amendment 4: simple/advanced toggle, simple by default.
 *
 * JUDGMENT: the amendment names the toggle but not what each view carries.
 * Simple is the book — who they are and whether work is open. Advanced adds
 * every channel with its per-channel consent, relationships and source (the
 * mockup's full row). Re-cutting the split is a wording change, not structure.
 */

function channelLabel(channel: string): string {
  if (channel === "whatsapp") return "WhatsApp";
  if (channel === "sms") return "SMS";
  return channel;
}

function Chip({
  tone = "neutral",
  children,
}: {
  tone?: "green" | "gold" | "red" | "none" | "neutral";
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "rounded-md border px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wide",
        tone === "green" && "border-ledger-line bg-ledger-tint text-ledger",
        tone === "gold" && "border-[#e3cd9c] bg-gold-tint text-gold",
        tone === "red" && "border-[#e8bcb2] bg-stamp-tint text-stamp",
        tone === "none" && "border-dashed border-rule bg-transparent text-ink-faint",
        tone === "neutral" && "border-rule bg-paper text-ink-soft"
      )}
    >
      {children}
    </span>
  );
}

function consentedKinds(consent: Record<string, unknown>): string[] {
  return ["transactional", "marketing"].filter((k) => consent[k] === true);
}

function Row({ contact, advanced }: { contact: ContactListRow; advanced: boolean }) {
  const junk = contact.status === "junk";
  return (
    <Link
      href={`/contacts/${contact.id}`}
      className={cn(
        "glass mb-2 flex flex-wrap items-center gap-3 rounded-xl px-3.5 py-3 transition-colors hover:border-ledger",
        junk && "opacity-55"
      )}
    >
      <div className="min-w-[150px]">
        <div className="text-sm font-bold">{contact.name}</div>
        <div className="mt-px font-mono text-[10px] tracking-wide text-ink-faint uppercase">
          {contact.type} · {contact.status.replace(/_/g, " ")} · {contact.locale}
        </div>
      </div>
      <div className="flex flex-1 flex-wrap items-center gap-1.5">
        {contact.openEnquiries > 0 ? (
          <Chip tone="gold">
            {contact.openEnquiries} open enquir{contact.openEnquiries > 1 ? "ies" : "y"} — tap to
            open
          </Chip>
        ) : null}
        {junk ? <Chip tone="red">junk — kept for the Meta feedback loop</Chip> : null}
        {advanced ? (
          <>
            {contact.channels.map((channel) => {
              const kinds = consentedKinds(channel.consent);
              return kinds.length ? (
                <Chip key={`${channel.channel}-${channel.value}`} tone="green">
                  {channelLabel(channel.channel)} ✓ {kinds.join(" · ")}
                </Chip>
              ) : (
                <Chip key={`${channel.channel}-${channel.value}`} tone="none">
                  {channelLabel(channel.channel)} — no consent recorded
                </Chip>
              );
            })}
            {contact.channels.length === 0 ? <Chip tone="none">no channels yet</Chip> : null}
            {contact.relationships.map((rel) => (
              <Chip key={`${rel.contactId}-${rel.relationship}-${rel.direction}`}>
                {rel.direction === "out"
                  ? `${rel.relationship.replace(/_/g, " ")} of ${rel.name}`
                  : `${rel.name} is their ${rel.relationship.replace(/_/g, " ")}`}
              </Chip>
            ))}
            {contact.source ? (
              <Chip>source: {contact.source === "meta" ? "Meta" : contact.source}</Chip>
            ) : null}
          </>
        ) : null}
      </div>
    </Link>
  );
}

export function ContactsList({ contacts }: { contacts: ContactListRow[] }) {
  const [advanced, setAdvanced] = useState(false);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <div className="flex rounded-lg border border-rule bg-paper-deep p-0.5">
          {([false, true] as const).map((mode) => (
            <button
              key={String(mode)}
              type="button"
              onClick={() => setAdvanced(mode)}
              className={cn(
                "rounded-md px-3 py-1 font-mono text-[10.5px] font-semibold tracking-wide uppercase transition-colors",
                advanced === mode ? "bg-ink text-paper" : "text-ink-soft"
              )}
            >
              {mode ? "Advanced" : "Simple"}
            </button>
          ))}
        </div>
        <span className="font-mono text-[10.5px] tracking-wide text-ink-faint uppercase">
          {advanced
            ? "Every channel, consent, source and relationship"
            : "Who they are and what is open"}
        </span>
      </div>

      {contacts.map((contact) => (
        <Row key={contact.id} contact={contact} advanced={advanced} />
      ))}
      {contacts.length === 0 ? (
        <div className="glass rounded-xl border-dashed p-8 text-center font-mono text-xs tracking-wide text-ink-faint uppercase">
          No contacts yet — they arrive by themselves from leads and forms
        </div>
      ) : null}

      <p className="mt-3 font-mono text-xs text-ink-faint">
        CONSENT IS PER CHANNEL, NOT PER PERSON — LEGALLY AND IN THE SCHEMA. ONLY CONSENTED
        CHANNELS WILL APPEAR IN THE COMPOSER.
      </p>
    </>
  );
}
