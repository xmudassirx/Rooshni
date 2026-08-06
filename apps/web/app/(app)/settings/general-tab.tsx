import {
  isQuietHoursSet,
  loadMemoryContext,
  memoryFactValue,
  resolveQuietHoursWithSource,
  sendWindowFromQuietHours,
  MEMORY_FACT_KEYS,
  QUIET_HOURS_DEFAULT,
} from "@rooshni/db";

import { HonestButton } from "@/components/ui/honest-button";
import { getAppContext } from "@/lib/server/context";
import { getBusinessConfig, getTemplateContent } from "@/lib/server/queries";
import { BusinessHoursControl } from "./business-hours-control";
import { DraftingSettings } from "./drafting-settings";
import { QuietHoursControl } from "./quiet-hours-control";

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
  v: React.ReactNode;
  small?: string;
  action?: React.ReactNode;
}) {
  return (
    // WS4g (Session 23): on a phone the row stacks label-over-value — the
    // fixed label column would otherwise crush the value into overflow.
    <div className="flex items-baseline gap-3 border-b border-dashed border-paper-deep py-2.5 text-[13px] last:border-b-0 max-[560px]:flex-wrap max-[560px]:gap-y-1">
      <span className="w-43 shrink-0 font-mono text-[9.5px] font-semibold tracking-[.08em] text-ink-faint uppercase max-[560px]:w-full">
        {k}
      </span>
      <span className="min-w-0 flex-1 break-words text-ink">
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
  // Session 11: vertical content (display name, pack categories, no-go
  // rules) renders FROM the installed template definition.
  const [config, template, { db, business, membershipRole }] = await Promise.all([
    getBusinessConfig(),
    getTemplateContent(),
    getAppContext(),
  ]);
  const s = config.settings;
  // Session 32 (D181, Q1): sign-off text and booking URL read memory-first —
  // the fields are faces over the facts; settings is the transitional
  // pre-seed fallback.
  const memory = await loadMemoryContext(db, business.id);
  // Session 26 (C5, founder-ruled): the unset-firm default resolves from the
  // installed template's declared quiet hours — the SAME resolver the
  // dispatch hold reads, so display and enforcement cannot disagree.
  // Quiet-window micro-fix (7 Aug 2026): resolved WITH its true source —
  // the row states provenance, never a claimed derivation.
  const { window: quiet, source: quietSource } = resolveQuietHoursWithSource(
    s,
    template?.quietHoursDefault ?? null
  );

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
        {/* Defect-trio hotfix (2 Aug 2026, item 3): business hours go real —
            this control edits settings.quiet_hours, THE config the dispatch
            hold reads, and the quiet-hours row below renders from the SAME
            resolver, so display and enforcement cannot disagree. */}
        <Row
          k="Business hours"
          v={
            <BusinessHoursControl
              value={{
                // Session 33 (D184b): when quiet hours are OFF the editor
                // prefills the shipped window so turning them back on is
                // one save, never a blank form.
                open: sendWindowFromQuietHours(quiet ?? QUIET_HOURS_DEFAULT).open,
                close: sendWindowFromQuietHours(quiet ?? QUIET_HOURS_DEFAULT).close,
                timezone: config.timezone,
                isSet: isQuietHoursSet(s),
                disabled: quiet === null,
                isOwner: membershipRole === "owner",
                // Fact-surfaces micro-fix (defect B): the field renders the
                // MEMORY fact memory-first — the same home it writes
                // through; the window string is only the pre-fact fallback.
                memoryValue: memoryFactValue(memory, MEMORY_FACT_KEYS.openingHours),
              }}
            />
          }
        />
        {/* Quiet-window micro-fix (7 Aug 2026, founder-witnessed): the row
            states the resolved window with its TRUE source and carries its
            own editor — both acts through the one shared door. */}
        <Row
          k="Quiet hours"
          v={
            <QuietHoursControl
              value={{
                start: quiet?.start ?? null,
                end: quiet?.end ?? null,
                source: quietSource,
                isOwner: membershipRole === "owner",
              }}
            />
          }
          small="Approving inside quiet hours surfaces the choice at the stamp: send now (the override is recorded, with your name) or approve and schedule a dispatch time. One config: this line, the dialogue and the dispatch hold read the same source."
        />
      </div>
      <div className="glass rounded-xl px-4 py-1.5">
        <Row
          k="Vertical template"
          v={
            template
              ? `${template.displayName} · v${template.version}`
              : config.template
                ? `${config.template.vertical} · v${config.template.version}`
                : "None"
          }
          small="Vocabulary (“enquiry”), pipeline stages, no-go rules, knowledge pack — one bundle over the six primitives, installed from the definition"
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
          v={
            template?.knowledgePackCategories.length
              ? `Live · ${template.knowledgePackCategories.length} categories`
              : "No template installed"
          }
          small="What Light may draft from — curated in the Knowledge tab (the one door); Light reads published entries only, task-scoped, and names its sources on every draft's credit line."
          action={
            <HonestButton
              size="sm"
              variant="ghost"
              notice="The pack lives in the Knowledge tab above — every entry versioned, every change on The Record."
            >
              view
            </HonestButton>
          }
        />
        <Row
          k="No-go rules"
          v={
            template
              ? `${template.noGoRules.length} active`
              : config.template
                ? `${config.template.noGoRules} active`
                : "None"
          }
          small={
            template?.noGoRules.length
              ? template.noGoRules.map((r, i) => `${i + 1}. ${r}`).join("  ")
              : "Enforced at pre-flight, not by hope"
          }
          action={
            <HonestButton
              size="sm"
              variant="ghost"
              notice="No-go rules are firm-editable in plain English with their session; each edit is evented. Reviewing them in First Light earns that row's tick."
            >
              view
            </HonestButton>
          }
        />
      </div>
      {/* Session 16 — the drafting policy trio: sign-off text (the Session 15
          JUDGMENT mark redeemed), sign-off mode (PR-F) and the reply settle
          window (PR-C). */}
      <DraftingSettings
        signOffText={memoryFactValue(memory, MEMORY_FACT_KEYS.signature) ?? str(s, "email_sign_off")}
        signOffMode={s.email_sign_off_mode === "approver" ? "approver" : "firm_name"}
        bookingUrl={memoryFactValue(memory, MEMORY_FACT_KEYS.bookingLink) ?? str(s, "booking_url")}
        settleMinutes={
          typeof s.draft_settle_minutes === "number" &&
          [0, 1, 3, 5].includes(s.draft_settle_minutes)
            ? s.draft_settle_minutes
            : 3
        }
        businessName={business.name}
        isOwner={membershipRole === "owner"}
      />
    </>
  );
}
