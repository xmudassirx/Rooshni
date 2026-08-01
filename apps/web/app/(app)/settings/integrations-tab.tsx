import { Mail, MessageCircle, LayoutGrid, CalendarClock, PoundSterling } from "lucide-react";

import { HonestButton } from "@/components/ui/honest-button";
import { getIntegrationStates, getMailPipeState } from "@/lib/server/queries";
import { MailProviderControl } from "./mail-provider-control";

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
  key: "mail" | "whatsapp" | "meta" | "calendar" | "stripe";
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
  const [states, mailPipe] = await Promise.all([getIntegrationStates(), getMailPipeState()]);
  const stateByKey = new Map(states.map((s) => [s.key, s]));

  return (
    <div className="glass rounded-xl">
      <h2 className="border-b border-ink/10 px-4.5 py-3 font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-soft uppercase">
        Integrations · every provider is an actor with grants
      </h2>
      {ROWS.map((row) => {
        const state = stateByKey.get(row.key);
        const connected = state?.connected ?? false;
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
                {connected ? "connected" : "not connected"}
              </span>
              <HonestButton size="sm" variant="ghost" notice={row.notice}>
                {connected ? "manage" : "connect"}
              </HonestButton>
            </div>
            {/* Session 20: the mail pipe is chosen HERE — one door. */}
            {row.key === "mail" ? <MailProviderControl pipe={mailPipe} /> : null}
          </div>
        );
      })}
      <p className="px-4.5 py-3 font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">
        One door — signup never asked for a credential and never will. Connections made here reflect straight back into First Light.
      </p>
    </div>
  );
}
