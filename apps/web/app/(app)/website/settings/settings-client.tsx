"use client";

import { useState } from "react";
import Link from "next/link";

import type { DomainRow } from "@/lib/server/queries";
import { cn } from "@/lib/utils";

/*
 * view-wssettings, master mockup v2: eight tabs over the site's standing
 * configuration. Connections live ONCE in Settings → Integrations (decision
 * 58); these tabs hold behaviour only. Domains render real rows; every
 * unbuilt store states its honest not-yet.
 */

const TABS = [
  "Header & Footer",
  "Domain & Nav",
  "Identity & Branding",
  "SEO & Schema",
  "Redirects",
  "Cookies & Consent",
  "Writing standards",
  "Access",
] as const;

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="glass mb-4 overflow-hidden rounded-xl">
      <h2 className="border-b border-rule bg-paper px-4 py-3 font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-soft uppercase">
        {title}
      </h2>
      {children}
    </div>
  );
}

function EmptyRows({ children }: { children: React.ReactNode }) {
  return <p className="max-w-[75ch] px-5 py-6 text-[13px] text-ink-soft">{children}</p>;
}

function CfgRow({
  title,
  detail,
  href,
}: {
  title: string;
  detail: string;
  href?: string;
}) {
  const inner = (
    <>
      <b className="text-[13.5px]">{title}</b>
      <span className="text-[12.5px] text-ink-soft">{detail}</span>
      <span className="text-right text-[15px] text-ink-faint">›</span>
    </>
  );
  const cls =
    "grid w-full grid-cols-[250px_1fr_18px] items-center gap-5 border-b border-rule px-5 py-3.5 text-left last:border-b-0 hover:bg-paper-deep max-[720px]:grid-cols-[1fr_18px]";
  return href ? (
    <Link href={href} className={cls}>
      {inner}
    </Link>
  ) : (
    <div className={cn(cls, "hover:bg-transparent")}>{inner}</div>
  );
}

export function WebsiteSettingsClient({ domains }: { domains: DomainRow[] }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Header & Footer");

  return (
    <>
      <div className="mb-3.5 flex flex-wrap items-center gap-1.5">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "rounded-2xl border px-3 py-1 font-mono text-[11px] font-semibold tracking-wide uppercase",
              tab === t ? "border-ink bg-ink text-paper" : "border-rule bg-panel text-ink-soft"
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Header & Footer" ? (
        <>
          <Panel title="Headers · save many, one active per scope — an activated scoped header replaces the global one on its pages">
            <EmptyRows>
              No headers yet — the first is born with the site. Every header
              edit is a Level 3 site-wide publish, and scoped headers (blog,
              funnels) replace the global one only on their pages.
            </EmptyRows>
          </Panel>
          <Panel title="Footers · same model — and the locked compliance lines travel with every one of them">
            <EmptyRows>
              No footers yet. When they exist, the locked compliance lines —
              accreditation, address, complaints, privacy — are enforced by
              no-go rules: validation refuses any footer without them.
            </EmptyRows>
          </Panel>
        </>
      ) : null}

      {tab === "Domain & Nav" ? (
        <>
          <Panel title="Domain & SSL">
            {domains.length ? (
              domains.map((d) => (
                <CfgRow
                  key={d.hostname}
                  title={d.hostname}
                  detail={`${d.surface} · verification ${d.verificationStatus} · SSL ${d.sslStatus}`}
                />
              ))
            ) : (
              <EmptyRows>
                No domain connected — the tenant&rsquo;s site lives on the
                tenant&rsquo;s own domain, connected in its session.
              </EmptyRows>
            )}
          </Panel>
          <Panel title="Navigation menu">
            <EmptyRows>
              No navigation yet — nav changes are site-wide, so they pass the
              gate; a newly published category proposes its own entry, added
              only on your confirm.
            </EmptyRows>
          </Panel>
        </>
      ) : null}

      {tab === "Identity & Branding" ? (
        <Panel title="Identity & Branding · rides the same token engine as this app">
          <EmptyRows>
            Logo set, design tokens and image style configure here once the
            site exists — one token system, shared by the site and this app.
          </EmptyRows>
        </Panel>
      ) : null}

      {tab === "SEO & Schema" ? (
        <Panel title="SEO defaults & site-wide schema">
          <EmptyRows>
            The firm-level LegalService record, title and meta patterns,
            sitemap and the curated tag library configure here with the
            website-content session — inherited by every page&rsquo;s schema.
          </EmptyRows>
        </Panel>
      ) : null}

      {tab === "Redirects" ? (
        <Panel title="Redirects">
          <EmptyRows>
            No redirect rules yet. The broken-link guard is law from day one:
            deleting a published page will force a redirect decision — no dead
            links.
          </EmptyRows>
        </Panel>
      ) : null}

      {tab === "Cookies & Consent" ? (
        <Panel title="Cookies & consent">
          <EmptyRows>
            First-party analytics only by default — no third-party pixels
            without consent, and adding any tracker forces banner re-consent.
            The banner ships with the site.
          </EmptyRows>
        </Panel>
      ) : null}

      {tab === "Writing standards" ? (
        <Panel title="Writing standards · they live in Light's Memory, not buried here">
          <CfgRow
            href="/memory"
            title="Web voice · Blog voice"
            detail="Writing standards are memory cards — edit the card, every future draft obeys. The memory store is Spec 2's session."
          />
          <p className="px-5 pb-3.5 font-mono text-[11px] text-ink-faint uppercase">
            Edit the card, every future draft obeys — the setting is the memory.
          </p>
        </Panel>
      ) : null}

      {tab === "Access" ? (
        <Panel title="Access · governed by grants, managed in Settings → Team & Access">
          <CfgRow
            href="/settings"
            title="Who sees Website"
            detail="Grants decide — no website grant, no Website tab, and no website approvals in that person's inbox."
          />
        </Panel>
      ) : null}

      <p className="font-mono text-xs text-ink-faint">
        SITE-WIDE CHANGES ARE LEVEL 3 — A HEADER EDIT TOUCHES EVERY PAGE, SO IT PASSES THE
        SAME GATE AS A SEND. CONNECTIONS LIVE ONCE, IN SETTINGS → INTEGRATIONS (DECISION 58).
      </p>
    </>
  );
}
