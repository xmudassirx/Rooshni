"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatWhen } from "@/lib/format";
import type { ContactListRow } from "@/lib/server/queries";
import { cn } from "@/lib/utils";

/*
 * view-contacts, master mockup v2: Simple is the receptionist's view (rows
 * with consent chips and the open-enquiry link); Advanced is the operator's
 * table. Tags and Owner are drawn columns with no backing columns yet — they
 * render an honest "—", never invented values.
 */

function channelLabel(channel: string): string {
  if (channel === "whatsapp") return "WhatsApp";
  if (channel === "sms") return "SMS";
  return channel.charAt(0).toUpperCase() + channel.slice(1).replace(/_/g, " ");
}

function initials(row: ContactListRow): string {
  if (row.type === "organisation") return "▦";
  return row.name
    .replace(/"/g, "")
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function typeChip(row: ContactListRow): { label: string; kind: "client" | "junk" | "plain" } {
  if (row.status === "junk") return { label: "Junk", kind: "junk" };
  if (row.type === "organisation") return { label: "Org", kind: "plain" };
  if (row.isClient) return { label: "Client", kind: "client" };
  return { label: "Lead", kind: "plain" };
}

function consented(row: ContactListRow): string[] {
  return row.channels
    .filter((c) => ["transactional", "marketing"].some((k) => c.consent[k] === true))
    .map((c) => channelLabel(c.channel));
}

function TypeChip({ row }: { row: ContactListRow }) {
  const t = typeChip(row);
  return (
    <span
      className={cn(
        "rounded-lg border px-1.5 py-px font-mono text-[9px] tracking-wide uppercase",
        t.kind === "client" && "border-ledger-line bg-ledger-tint text-ledger",
        t.kind === "junk" && "border-[#e8c4bc] bg-stamp-tint text-stamp",
        t.kind === "plain" && "border-rule bg-paper-deep text-ink-soft"
      )}
    >
      {t.label}
    </span>
  );
}

export function ContactsList({ contacts }: { contacts: ContactListRow[] }) {
  const [advanced, setAdvanced] = useState(false);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const router = useRouter();

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.channels.some((ch) => ch.value.toLowerCase().includes(q))
    );
  }, [contacts, query]);

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <div className="flex gap-0.5 rounded-md bg-paper-deep p-0.5">
          {([false, true] as const).map((mode) => (
            <button
              key={String(mode)}
              type="button"
              onClick={() => setAdvanced(mode)}
              className={cn(
                "rounded px-3 py-1 font-mono text-[9.5px] font-semibold tracking-wide uppercase",
                advanced === mode ? "bg-panel text-ink shadow-panel" : "text-ink-soft"
              )}
            >
              {mode ? "Advanced" : "Simple"}
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-2">
          <Button
            onClick={() =>
              setNotice(
                "Import — CSV or straight from the old CRM, channels and consent mapped at the door. Arrives with its own session."
              )
            }
          >
            ⇪ Import
          </Button>
          <Button
            variant="primary"
            onClick={() =>
              setNotice(
                "Manual creation arrives with its session — most contacts arrive by themselves from leads and forms."
              )
            }
          >
            + New contact
          </Button>
        </div>
      </div>
      {notice ? (
        <p className="mb-2.5 font-mono text-[10.5px] tracking-wide text-amber uppercase">
          {notice}
        </p>
      ) : null}

      <label className="mb-3 flex max-w-[360px] items-center gap-2 rounded-lg border border-rule bg-panel px-3 py-2 text-[13px] text-ink-faint shadow-panel">
        <Search className="size-3.5" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, phone, email…"
          className="w-full bg-transparent text-ink outline-none placeholder:text-ink-faint"
        />
      </label>

      {!advanced ? (
        <>
          {visible.map((c) => (
            <Link
              key={c.id}
              href={`/contacts/${c.id}`}
              className={cn(
                "glass mb-2 flex flex-wrap items-center gap-3 rounded-xl px-4 py-3 transition-colors hover:border-accent",
                c.status === "junk" && "opacity-55"
              )}
            >
              <span className="flex size-8.5 shrink-0 items-center justify-center rounded-full border border-rule bg-paper-deep text-xs font-bold text-ink-soft">
                {initials(c)}
              </span>
              <span>
                <span className="block text-sm font-bold">{c.name}</span>
                <span className="block font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">
                  {c.type} · {c.status.replace(/_/g, " ")} · {c.locale}
                </span>
              </span>
              <span className="ml-auto flex flex-wrap justify-end gap-1.5">
                {consented(c).map((label) => (
                  <span
                    key={label}
                    className="rounded-lg border border-ledger-line bg-ledger-tint px-2 py-px font-mono text-[9.5px] text-ledger"
                  >
                    {label} ✓
                  </span>
                ))}
                {c.openEnquiries > 0 ? (
                  <span className="rounded-lg border border-accent bg-accent-tint px-2 py-px font-mono text-[9.5px] font-semibold text-accent">
                    {c.openEnquiries} open enquir{c.openEnquiries > 1 ? "ies" : "y"} — tap
                  </span>
                ) : (
                  <span className="rounded-lg border border-rule bg-paper px-2 py-px font-mono text-[9.5px] text-ink-soft">
                    no open enquiry
                  </span>
                )}
              </span>
            </Link>
          ))}
        </>
      ) : (
        <div className="glass overflow-auto rounded-xl">
          <table className="w-full min-w-[760px] border-collapse">
            <thead>
              <tr>
                {[
                  "Name",
                  "Type",
                  "Phone",
                  "Email",
                  "Owner",
                  "Source",
                  "Tags",
                  "Last activity",
                ].map((h) => (
                  <th
                    key={h}
                    className="border-b border-rule bg-accent-tint px-3 py-2 text-left font-mono text-[9px] font-semibold tracking-[.1em] whitespace-nowrap text-accent uppercase"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => router.push(`/contacts/${c.id}`)}
                  className="cursor-pointer hover:bg-paper"
                >
                  <td className="border-b border-paper-deep px-3 py-2.5 text-[12.5px] font-semibold whitespace-nowrap">
                    {c.name}
                  </td>
                  <td className="border-b border-paper-deep px-3 py-2.5">
                    <TypeChip row={c} />
                  </td>
                  <td className="border-b border-paper-deep px-3 py-2.5 font-mono text-[11px] whitespace-nowrap">
                    {c.phone ?? "—"}
                  </td>
                  <td className="border-b border-paper-deep px-3 py-2.5 font-mono text-[11px] whitespace-nowrap">
                    {c.email ?? "—"}
                  </td>
                  <td className="border-b border-paper-deep px-3 py-2.5 text-[12.5px] whitespace-nowrap">
                    —
                  </td>
                  <td className="border-b border-paper-deep px-3 py-2.5 text-[12.5px] whitespace-nowrap">
                    {c.source ? (c.source === "meta" ? "Meta" : c.source) : "—"}
                  </td>
                  <td className="border-b border-paper-deep px-3 py-2.5 text-[12.5px] whitespace-nowrap">
                    —
                  </td>
                  <td className="border-b border-paper-deep px-3 py-2.5 font-mono text-[10.5px] whitespace-nowrap text-ink-faint">
                    {c.lastActivityAt ? formatWhen(c.lastActivityAt) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {visible.length === 0 ? (
        <div className="glass rounded-xl border-dashed p-8 text-center font-mono text-xs tracking-wide text-ink-faint uppercase">
          {contacts.length === 0
            ? "No contacts yet — they arrive by themselves from leads and forms"
            : "No contacts match the search"}
        </div>
      ) : null}

      <p className="mt-3 font-mono text-xs text-ink-faint">
        SIMPLE IS THE RECEPTIONIST&rsquo;S VIEW · ADVANCED IS THE OPERATOR&rsquo;S TABLE · BULK
        ACTIONS &amp; SAVED SMART LISTS — PHASE 2 · CONSENT IS PER CHANNEL, NOT PER PERSON
      </p>
    </>
  );
}
