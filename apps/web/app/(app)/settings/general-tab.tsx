import { HonestButton } from "@/components/ui/honest-button";
import { getBusinessConfig } from "@/lib/server/queries";

/*
 * Settings → General, master mockup v2 (setSTab 'general'): identity and
 * policy in one place. Real columns render real values (businesses.name,
 * timezone, default_locale; the template's vertical, version and no-go
 * count). Keys the schema does not hold yet — regulated status, address,
 * languages, business hours, quiet hours — read from businesses.settings
 * when present and say honestly when they are not. No fabricated values.
 */

function str(settings: Record<string, unknown>, key: string): string | null {
  const v = settings[key];
  return typeof v === "string" && v.trim() ? v : null;
}

function Row({
  k,
  v,
  small,
  action,
}: {
  k: string;
  v: string;
  small?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-3 border-b border-dashed border-paper-deep py-2.5 text-[13px] last:border-b-0">
      <span className="w-43 shrink-0 font-mono text-[9.5px] font-semibold tracking-[.08em] text-ink-faint uppercase">
        {k}
      </span>
      <span className="flex-1 text-ink">
        {v}
        {small ? <small className="mt-0.5 block text-[11px] text-ink-faint">{small}</small> : null}
      </span>
      {action ? <span className="shrink-0">{action}</span> : null}
    </div>
  );
}

const EDIT_NOTICE =
  "Editable with the settings session — saved as business config, and the change itself is a line on The Record (settings.updated).";

export async function GeneralTab() {
  const config = await getBusinessConfig();
  const s = config.settings;

  const edit = (
    <HonestButton size="sm" variant="ghost" notice={EDIT_NOTICE}>
      edit
    </HonestButton>
  );

  return (
    <>
      <div className="glass mb-3 rounded-xl px-4 py-1.5">
        <Row
          k="Business name"
          v={config.name}
          small="Shown in the shell, footers and Light's disclosures"
          action={edit}
        />
        <Row
          k="Regulated status"
          v={str(s, "regulated_status") ?? "Not set"}
          small="Injected into email footers, WhatsApp templates and the Phase 3 voice disclosure — compliance strings live in one place. Arrives with the settings session."
          action={edit}
        />
        <Row
          k="Address"
          v={str(s, "address") ?? "Not set"}
          small={str(s, "address") ? undefined : "Arrives with the settings session"}
          action={edit}
        />
        <Row
          k="Locale & timezone"
          v={`${config.locale} · ${config.timezone}`}
          action={edit}
        />
        <Row
          k="Languages"
          v={str(s, "languages") ?? "Not set"}
          small="Light drafts in the client's language where consented channels support it. Arrives with the settings session."
          action={edit}
        />
        <Row
          k="Business hours"
          v={str(s, "business_hours") ?? "Not set"}
          small={str(s, "business_hours") ? undefined : "Arrives with the settings session"}
          action={edit}
        />
        <Row
          k="Quiet hours"
          v={str(s, "quiet_hours") ?? "Not set"}
          small="Stamped messages that hit quiet hours queue and dispatch when they end — the stamp is yours, the timing is policy. Arrives with the send session."
          action={edit}
        />
      </div>
      <div className="glass rounded-xl px-4 py-1.5">
        <Row
          k="Vertical template"
          v={
            config.template
              ? `${config.template.vertical} · v${config.template.version}`
              : "None"
          }
          small="Vocabulary (“enquiry”), pipeline stages, no-go rules, knowledge pack — one bundle over the six primitives"
          action={
            <HonestButton
              size="sm"
              variant="ghost"
              notice="Changing the vertical template is a gated, owner-only action — it rewrites vocabulary and stages across every surface. Arrives with its session."
            >
              change
            </HonestButton>
          }
        />
        <Row
          k="Knowledge pack"
          v="Not yet built"
          small="What Light may answer from — advice beyond the pack always deflects to booking. The pack store arrives with its session."
          action={
            <HonestButton
              size="sm"
              variant="ghost"
              notice="Pack contents will be inspectable — every entry, its source and its last review date. The store arrives with its session."
            >
              view
            </HonestButton>
          }
        />
        <Row
          k="No-go rules"
          v={
            config.template
              ? `${config.template.noGoRules} active`
              : "None"
          }
          small="e.g. never advise before instruction · never promise outcomes — enforced at pre-flight, not by hope"
          action={
            <HonestButton
              size="sm"
              variant="ghost"
              notice="No-go rules are readable and editable in plain English with their session; each edit is evented."
            >
              view
            </HonestButton>
          }
        />
      </div>
    </>
  );
}
