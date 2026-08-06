import { Mail, MessageCircle, LayoutGrid, CalendarClock, PoundSterling, Radar } from "lucide-react";

import { HonestButton } from "@/components/ui/honest-button";
import {
  getConversionsState,
  getIntegrationStates,
  getMailPipeState,
  getMetaFormRoutesState,
} from "@/lib/server/queries";
import { ConversionsControl } from "./conversions-control";
import { MailProviderControl } from "./mail-provider-control";
import { MetaFormRoutesControl } from "./meta-form-routes-control";

/*
 * Settings → Integrations (Session 11; mockup: onboarding-wizard Pass 4 v2;
 * Session 20 adds the mail-pipe choice to the mail row — ordered in the
 * session prompt). The ONE door (decision 58): connections live here, once —
 * First Light rows deep-link to this tab and state reflects back. State is
 * read the way the predicates read it: a live grant to an integration actor
 * IS the connection; nothing here is fabricated, and no credential field
 * ever renders in First Light. OAuth wiring for mail/calendar and WhatsApp
 * arrives with its own sessions — the connect buttons say so honestly.
 */

const ROWS: {
  key: "mail" | "whatsapp" | "meta" | "conversions" | "calendar" | "stripe";
  icon: React.ComponentType<{ className?: string }>;
  name: string;
  meta: string;
  notice: string;
}[] = [
  {
    key: "mail",
    icon: Mail,
    name: "Microsoft 365 / Google Workspace",
    meta: "mail + calendar · sends 1:1 as the firm",
    notice:
      "OAuth connect arrives with its wiring session. The integration joins as an actor with zero grants until you scope it; the First Light tick lands the moment its grant exists.",
  },
  {
    key: "whatsapp",
    icon: MessageCircle,
    name: "WhatsApp Business",
    meta: "session & template rules handled at pre-flight",
    notice:
      "Number connect arrives with its wiring session. Session-window law is already enforced at pre-flight; the First Light tick lands when the grant exists.",
  },
  {
    key: "meta",
    icon: LayoutGrid,
    name: "Meta Lead Forms",
    meta: "forms map → contacts + enquiries · consent captured at the form",
    notice:
      "Per-tenant connect arrives with its wiring session — the platform webhook and page binding already exist (Session 10).",
  },
  {
    key: "conversions",
    icon: Radar,
    name: "Meta Conversions",
    meta: "outcomes back to the ad platform · Schedule + Purchase only, hashed match keys",
    notice:
      "Session 22: the loop is built and OFF by default. The control below is the one door — toggle, dataset id and test event code; nothing fires until the owner flips it.",
  },
  {
    key: "calendar",
    icon: CalendarClock,
    name: "Calendar",
    meta: "availability feeds booking links & the slot pre-flight check",
    notice:
      "Arrives with the booking-link session — booking links will offer only real free/busy, through the product's own mechanism.",
  },
  {
    key: "stripe",
    icon: PoundSterling,
    name: "Stripe",
    meta: "your plan payment created this actor at signup",
    notice:
      "Manage arrives with the billing session: its grants, every row it wrote on The Record, or disconnect (gated).",
  },
];

export async function IntegrationsTab() {
  const [states, mailPipe, conversions, formRoutes] = await Promise.all([
    getIntegrationStates(),
    getMailPipeState(),
    getConversionsState(),
    getMetaFormRoutesState(),
  ]);
  const stateByKey = new Map(states.map((s) => [s.key, s]));

  return (
    <div className="glass rounded-xl">
      <h2 className="border-b border-ink/10 px-4.5 py-3 font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-soft uppercase">
        Integrations · every provider is an actor with grants
      </h2>
      {ROWS.map((row) => {
        // Session 22: the Conversions row carries a REAL control (decision
        // 116 — no honest-placeholder button where a working door exists);
        // its state chip is the toggle's truth in ACCENT, never green.
        if (row.key === "conversions") {
          return (
            <div key={row.key} className="border-b border-ink/10 px-4.5 py-3.5 last:border-b-0">
              <div className="flex items-center gap-3">
                <row.icon className="size-[18px] shrink-0 text-ink-soft" />
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-bold">{row.name}</div>
                  <div className="text-[11.5px] text-ink-soft">{row.meta}</div>
                </div>
                <span
                  className={
                    conversions.enabled
                      ? "rounded-md border border-accent/40 bg-accent/10 px-2 py-1 font-mono text-[9.5px] tracking-wide text-accent uppercase"
                      : "rounded-md border border-ink/15 bg-paper-deep px-2 py-1 font-mono text-[9.5px] tracking-wide text-ink-faint uppercase"
                  }
                >
                  {conversions.enabled ? "on" : "off"}
                </span>
              </div>
              <ConversionsControl state={conversions} />
            </div>
          );
        }
        const state = stateByKey.get(row.key);
        const connected = state?.connected ?? false;
        // Session 30 (WS B2): a connection carried by environment credentials
        // is a real connection and says so — provenance named on the chip and
        // in the meta line, never an unearned negative (and never a
        // credentials UI: the one door arrives with its wiring session).
        const viaEnvironment = state?.provenance === "environment";
        const notice = viaEnvironment
          ? "Connected through environment credentials set at deploy — not through this door, so there is nothing to manage here yet. The number connect door arrives with its wiring session; the session-window law is already enforced at pre-flight."
          : row.notice;
        return (
          <div key={row.key} className="border-b border-ink/10 px-4.5 py-3.5 last:border-b-0">
            <div className="flex items-center gap-3">
              <row.icon className="size-[18px] shrink-0 text-ink-soft" />
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-bold">{row.name}</div>
                <div className="text-[11.5px] text-ink-soft">
                  {connected && state?.detail ? state.detail : row.meta}
                </div>
              </div>
              <span
                className={
                  connected
                    ? "rounded-md border border-ledger/40 bg-ledger/10 px-2 py-1 font-mono text-[9.5px] tracking-wide text-ledger uppercase"
                    : "rounded-md border border-ink/15 bg-paper-deep px-2 py-1 font-mono text-[9.5px] tracking-wide text-ink-faint uppercase"
                }
              >
                {connected ? (viaEnvironment ? "connected · env" : "connected") : "not connected"}
              </span>
              <HonestButton size="sm" variant="ghost" notice={notice}>
                {connected ? "manage" : "connect"}
              </HonestButton>
            </div>
            {/* Session 20: the mail pipe is chosen HERE — one door. */}
            {row.key === "mail" ? <MailProviderControl pipe={mailPipe} /> : null}
            {/* Session 27 (D161a): per-form default routes live under the
                Meta row — the one door; ingest reads this mapping. */}
            {row.key === "meta" ? <MetaFormRoutesControl state={formRoutes} /> : null}
          </div>
        );
      })}
      <p className="px-4.5 py-3 font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">
        One door — signup never asked for a credential and never will. Connections made here reflect straight back into First Light.
      </p>
    </div>
  );
}
