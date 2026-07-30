"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";

import {
  acknowledgeNogoRules,
  confirmBasicsRow,
  markBasicsRowNotApplicable,
  runFirstLightEvaluation,
  skipMetaRow,
  type ConfirmBasicsInput,
} from "@/app/(app)/first-light/actions";
import { cn } from "@/lib/utils";

/*
 * First Light (Session 11; decisions 81–83, mockup: onboarding-wizard-mockup
 * Pass 4 v2). A top-bar pill beside Ask Light — NOT a nav item — wearing
 * Light's channel (prism|gold; navigation rows inside take the accent). Rows
 * are the REAL tagged task rows; every tick is server-earned; rows whose
 * machinery does not exist yet say so honestly; when the last row earns its
 * tick the pill retires itself (rows stay in Tasks and on The Record).
 */

export interface FirstLightRowProp {
  predicateKey: string;
  title: string;
  description: string;
  optional: boolean;
  satisfiedAt: string | null;
  taskStatus: string;
  pendingArrival: string | null;
}

export interface FirstLightTemplateProp {
  displayName: string;
  version: number;
  regulatedStatusOptions: string[];
  noGoRules: string[];
  knowledgePackCategories: string[];
  quietHoursDefault: { start: string; end: string };
  standardKeys: string[];
}

export interface FirstLightBasicsProp {
  name: string;
  values: Record<string, string>;
  quietHours: { start: string; end: string } | null;
  /** key → addressed state + provenance line (Session 13: a row is addressed
   * by an explicit confirm OR an explicit not-applicable — never silently). */
  confirmed: Record<string, { state: "confirmed" | "not_applicable"; text: string }>;
}

const BASICS_LABELS: Record<string, string> = {
  business_name: "Business name",
  regulated_status: "Regulated status",
  address: "Address",
  business_hours: "Business hours",
  languages: "Languages",
  quiet_hours: "Quiet hours",
};

export function FirstLight({
  state,
  template,
  basics,
}: {
  state: { rows: FirstLightRowProp[]; doneCount: number; totalCount: number; retired: boolean; absent: boolean };
  template: FirstLightTemplateProp | null;
  basics: FirstLightBasicsProp;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [basicsOpen, setBasicsOpen] = useState(false);
  const [nogoOpen, setNogoOpen] = useState(false);
  const [skipPrompt, setSkipPrompt] = useState(false);
  const [skipReason, setSkipReason] = useState("");
  const [, startTransition] = useTransition();

  const live = !state.absent && !state.retired;

  // Surfaces open the panel by event (the dashboard's empty-state CTA) —
  // panel state lives here alone.
  useEffect(() => {
    if (!live) return;
    const handler = () => {
      setOpen(true);
      startTransition(async () => {
        await runFirstLightEvaluation();
        router.refresh();
      });
    };
    window.addEventListener("first-light:open", handler);
    return () => window.removeEventListener("first-light:open", handler);
  }, [live, router]);

  if (!live) return null;

  const openPanel = () => {
    setOpen(true);
    // One door reflecting back: connections made in Settings → Integrations
    // earn their tick server-side when the panel is next opened.
    startTransition(async () => {
      await runFirstLightEvaluation();
      router.refresh();
    });
  };

  const goIntegrations = () => {
    setOpen(false);
    router.push("/settings?tab=integrations");
  };

  return (
    <>
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openPanel())}
        className="light-mesh ml-auto flex shrink-0 cursor-pointer items-center gap-2 rounded-full px-3.5 py-1.5 text-[12.5px] font-bold shadow-panel transition-transform hover:-translate-y-px"
      >
        <span className="light-spark text-[14px] leading-none">✦</span>
        First Light
        <span className="font-mono text-[10.5px] font-semibold opacity-85">
          {state.doneCount} of {state.totalCount}
        </span>
      </button>

      {open ? (
        <>
          <button
            type="button"
            aria-label="Close First Light"
            className="fixed inset-0 z-60 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="glass fixed top-14 right-4 z-70 flex max-h-[80vh] w-[min(480px,94vw)] flex-col overflow-hidden rounded-2xl shadow-[0_18px_50px_rgba(30,37,48,.22)]">
            <div className="px-4.5 pt-3.5 pb-2.5">
              <div className="text-[15.5px] font-extrabold">
                <span className="light-spark">✦</span> First Light
              </div>
              <div className="mt-0.5 text-[12.5px] text-ink-soft">
                Your first week — every row is a real task, every tick is earned, never clicked away.
              </div>
            </div>
            <div className="flex flex-col gap-1.5 overflow-y-auto px-3.5 pb-3">
              {state.rows.map((row) => {
                const done = Boolean(row.satisfiedAt);
                const skipped = row.optional && row.taskStatus === "cancelled" && !done;
                return (
                  <div
                    key={row.predicateKey}
                    className="flex items-start gap-2.5 rounded-lg border border-ink/10 bg-paper px-3 py-2.5"
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex size-[19px] shrink-0 items-center justify-center rounded-full border-[1.5px] text-[10.5px] font-bold",
                        done
                          ? "border-ledger bg-ledger text-white"
                          : "border-ink-faint text-transparent"
                      )}
                    >
                      {done ? <Check className="size-3" strokeWidth={3} /> : null}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div
                        className={cn(
                          "text-[13px] font-semibold",
                          done && "text-ink-soft line-through",
                          skipped && "text-ink-faint line-through"
                        )}
                      >
                        {row.title}
                      </div>
                      <div className="mt-px text-[11.5px] text-ink-soft">
                        {row.description}{" "}
                        {row.pendingArrival && !done ? (
                          <span className="font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">
                            {row.pendingArrival}
                          </span>
                        ) : null}
                        {skipped ? (
                          <span className="font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">
                            skipped — on The Record
                          </span>
                        ) : null}
                      </div>
                      {row.predicateKey === "meta_lead_forms_connected" && !done && !skipped && skipPrompt ? (
                        <div className="mt-1.5 flex items-center gap-1.5">
                          <input
                            value={skipReason}
                            onChange={(e) => setSkipReason(e.target.value)}
                            placeholder="Why skip? e.g. we don't run ads"
                            className="w-full rounded-md border border-ink/15 bg-panel px-2 py-1 text-[12px] outline-none focus:border-accent"
                          />
                          <button
                            type="button"
                            className="shrink-0 rounded-md border border-ink/15 px-2 py-1 text-[11px] font-semibold"
                            onClick={() =>
                              startTransition(async () => {
                                const r = await skipMetaRow(skipReason);
                                if (r.ok) {
                                  setSkipPrompt(false);
                                  router.refresh();
                                }
                              })
                            }
                          >
                            Skip it
                          </button>
                        </div>
                      ) : null}
                    </div>
                    {!done && !skipped ? (
                      <span className="flex shrink-0 flex-col items-end gap-1 self-center">
                        {row.predicateKey === "basics_confirmed" ? (
                          <button
                            type="button"
                            onClick={() => {
                              setOpen(false);
                              setBasicsOpen(true);
                            }}
                            className="rounded-md bg-accent px-2.5 py-1.5 text-[12px] font-semibold text-white"
                          >
                            Review
                          </button>
                        ) : row.predicateKey === "nogo_rules_acknowledged" ? (
                          <button
                            type="button"
                            onClick={() => {
                              setOpen(false);
                              setNogoOpen(true);
                            }}
                            className="rounded-md border border-ink/15 bg-panel px-2.5 py-1.5 text-[12px] font-semibold"
                          >
                            Read them
                          </button>
                        ) : row.predicateKey === "email_calendar_connected" ||
                          row.predicateKey === "whatsapp_connected" ||
                          row.predicateKey === "meta_lead_forms_connected" ? (
                          <>
                            <button
                              type="button"
                              onClick={goIntegrations}
                              className="rounded-md border border-ink/15 bg-panel px-2.5 py-1.5 text-[12px] font-semibold"
                            >
                              Connect
                            </button>
                            {row.optional ? (
                              <button
                                type="button"
                                className="font-mono text-[9.5px] tracking-wide text-ink-faint uppercase underline-offset-2 hover:underline"
                                onClick={() => setSkipPrompt((v) => !v)}
                              >
                                skip
                              </button>
                            ) : null}
                          </>
                        ) : null}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <div className="border-t border-ink/10 px-4.5 py-2.5 font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">
              Real rows in the tasks table · a tick is earned by the row's own check · when the last tick lands, First Light retires itself
            </div>
          </div>
        </>
      ) : null}

      {basicsOpen ? (
        <BasicsModal
          template={template}
          basics={basics}
          onClose={() => setBasicsOpen(false)}
        />
      ) : null}

      {nogoOpen && template ? (
        <div className="modal-scrim fixed inset-0 z-80 flex items-center justify-center p-4">
          <div className="modal-surface max-h-[85vh] w-[min(560px,94vw)] overflow-y-auto rounded-2xl">
            <div className="px-5 pt-4 pb-2">
              <div className="text-[15.5px] font-extrabold">
                Your no-go rules — {template.displayName} v{template.version}
              </div>
              <div className="mt-0.5 text-[12.5px] text-ink-soft">
                These ship with your vertical and are firm-editable later. Read them so you know exactly where Light stops.
              </div>
            </div>
            <ol className="flex flex-col gap-2 px-5 py-2">
              {template.noGoRules.map((rule, i) => (
                <li key={i} className="rounded-lg border border-ink/10 bg-paper px-3 py-2 text-[13px]">
                  <span className="mr-1.5 font-mono text-[10px] text-ink-faint">{i + 1}.</span>
                  {rule}
                </li>
              ))}
            </ol>
            <div className="flex items-center gap-2.5 border-t border-ink/10 px-5 py-3">
              <span className="flex-1 font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">
                Acknowledging is a line on The Record — the weakest tick, by design, and never a precedent
              </span>
              <button
                type="button"
                className="rounded-md border border-ink/15 bg-panel px-3 py-1.5 text-[12.5px] font-semibold"
                onClick={() => setNogoOpen(false)}
              >
                Not yet
              </button>
              <button
                type="button"
                className="rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-white"
                onClick={() =>
                  startTransition(async () => {
                    const r = await acknowledgeNogoRules();
                    if (r.ok) {
                      setNogoOpen(false);
                      router.refresh();
                    }
                  })
                }
              >
                I&rsquo;ve read them — acknowledge
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function BasicsModal({
  template,
  basics,
  onClose,
}: {
  template: FirstLightTemplateProp | null;
  basics: FirstLightBasicsProp;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const qhDefault = template?.quietHoursDefault ?? { start: "20:00", end: "08:00" };

  const initialValues = useMemo(
    () => ({
      business_name: basics.name,
      regulated_status: basics.values.regulated_status ?? "",
      address: basics.values.address ?? "",
      business_hours: basics.values.business_hours ?? "",
      languages: basics.values.languages ?? "",
    }),
    [basics]
  );
  const [values, setValues] = useState<Record<string, string>>(initialValues);
  const [qh, setQh] = useState(basics.quietHours ?? qhDefault);
  const [confirmed, setConfirmed] = useState(basics.confirmed);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Session 13: the displayed rows and the server's required set resolve
  // identically — template standard_keys when installed, else the canonical
  // six (resolveBasicsRequiredKeys in @rooshni/db carries the same fallback).
  const keys = template?.standardKeys?.length ? template.standardKeys : Object.keys(BASICS_LABELS);

  const valueFor = (key: string): string =>
    key === "quiet_hours" ? `${qh.start}–${qh.end}` : (values[key] ?? "").trim();

  const provenanceFor = (key: string): { text: string; read: boolean } => {
    if (confirmed[key]) return { text: confirmed[key]!.text, read: false };
    if (key === "business_name") return { text: "From your signup — already yours", read: true };
    if (key === "quiet_hours")
      return {
        text: "Our default for regulated firms — not read from your site; a suggestion, not a reading",
        read: false,
      };
    // Honest blank state: the crawl does not exist yet, so nothing was read.
    return { text: "Not read — no crawl has run yet. Yours to enter.", read: false };
  };

  const confirmOne = async (key: string): Promise<boolean> => {
    const input: ConfirmBasicsInput =
      key === "quiet_hours"
        ? { key, value: "", quietHours: qh }
        : { key: key as ConfirmBasicsInput["key"], value: values[key] ?? "" };
    const r = await confirmBasicsRow(input);
    if (!r.ok) {
      setErrors((e) => ({ ...e, [key]: r.error ?? "That did not save." }));
      return false;
    }
    setConfirmed((c) => ({
      ...c,
      [key]: { state: "confirmed", text: "Confirmed just now — on The Record" },
    }));
    return true;
  };

  const confirm = (key: string) => {
    setErrors((e) => ({ ...e, [key]: "" }));
    startTransition(async () => {
      if (await confirmOne(key)) router.refresh();
    });
  };

  const notApplicable = (key: string) => {
    setErrors((e) => ({ ...e, [key]: "" }));
    startTransition(async () => {
      const r = await markBasicsRowNotApplicable(key);
      if (!r.ok) {
        setErrors((e) => ({ ...e, [key]: r.error ?? "That did not save." }));
        return;
      }
      setConfirmed((c) => ({
        ...c,
        [key]: { state: "not_applicable", text: "Marked not applicable — on The Record" },
      }));
      router.refresh();
    });
  };

  // "Confirm all remaining" reaches ONLY rows holding a visible value the
  // founder has seen (the Session 13 law) — and it is the per-row confirm
  // looped, one act and one ledger line each, never a single blanket write.
  const confirmableRemaining = keys.filter((k) => !confirmed[k] && valueFor(k) !== "");
  const confirmAllRemaining = () => {
    startTransition(async () => {
      for (const key of confirmableRemaining) {
        if (!(await confirmOne(key))) break;
      }
      router.refresh();
    });
  };

  return (
    // The founder-screenshotted bleed: this modal was glass over a weak
    // scrim. Modals are opaque paper over the one shared scrim, both themes.
    <div className="modal-scrim fixed inset-0 z-80 flex items-center justify-center p-4">
      <div className="modal-surface max-h-[88vh] w-[min(640px,94vw)] overflow-y-auto rounded-2xl">
        <div className="px-5 pt-4 pb-2">
          <div className="text-[15.5px] font-extrabold">
            <span className="light-spark">✦</span> Your business basics — proposed, confirmed by you
          </div>
          <div className="mt-0.5 text-[12.5px] text-ink-soft">
            These fill Settings → General. Confirm each row or correct it. Rows nothing has read are honest about it.
          </div>
        </div>
        {keys.map((key) => {
          const prov = provenanceFor(key);
          const stamp = confirmed[key];
          const isConfirmed = Boolean(stamp);
          const canBeNotApplicable =
            !isConfirmed && key !== "business_name" && key !== "quiet_hours" && valueFor(key) === "";
          return (
            <div
              key={key}
              className="grid grid-cols-[140px_1fr_auto] items-center gap-x-3.5 gap-y-1 border-t border-ink/10 px-5 py-3 max-[560px]:grid-cols-1"
            >
              <span className="font-mono text-[10px] font-semibold tracking-wide text-ink-faint uppercase">
                {BASICS_LABELS[key] ?? key}
              </span>
              <span className="min-w-0">
                {key === "quiet_hours" ? (
                  <span className="flex items-center gap-1.5 text-[13px]">
                    No client sends
                    <input
                      type="time"
                      value={qh.start}
                      disabled={isConfirmed}
                      onChange={(e) => setQh((v) => ({ ...v, start: e.target.value }))}
                      className="rounded-md border border-ink/15 bg-paper px-1.5 py-1 text-[12.5px] disabled:border-transparent disabled:bg-transparent"
                    />
                    –
                    <input
                      type="time"
                      value={qh.end}
                      disabled={isConfirmed}
                      onChange={(e) => setQh((v) => ({ ...v, end: e.target.value }))}
                      className="rounded-md border border-ink/15 bg-paper px-1.5 py-1 text-[12.5px] disabled:border-transparent disabled:bg-transparent"
                    />
                  </span>
                ) : key === "regulated_status" && template?.regulatedStatusOptions.length ? (
                  <select
                    value={values[key] ?? ""}
                    disabled={isConfirmed}
                    onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                    className="w-full rounded-md border border-ink/15 bg-paper px-2 py-1.5 text-[13px] disabled:border-transparent disabled:bg-transparent disabled:text-ink-soft"
                  >
                    <option value="" disabled>
                      Choose your accreditation…
                    </option>
                    {template.regulatedStatusOptions.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={values[key] ?? ""}
                    disabled={isConfirmed}
                    onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                    placeholder={key === "address" ? "Street, city, postcode" : undefined}
                    className="w-full rounded-md border border-ink/15 bg-paper px-2.5 py-1.5 text-[13.5px] outline-none focus:border-accent disabled:border-transparent disabled:bg-transparent disabled:text-ink-soft"
                  />
                )}
                <span
                  className={cn(
                    "mt-0.5 block font-mono text-[9px] tracking-wide uppercase",
                    prov.read ? "light-text" : "text-ink-faint"
                  )}
                >
                  {prov.text}
                </span>
                {errors[key] ? (
                  <span className="mt-0.5 block text-[11px] text-stamp">{errors[key]}</span>
                ) : null}
              </span>
              <span className="flex flex-col items-end gap-1 self-center">
                {stamp ? (
                  stamp.state === "not_applicable" ? (
                    // Addressed but never confirmed — an honest neutral state,
                    // deliberately NOT the green of a done thing.
                    <span className="rounded-md border border-ink/15 bg-paper px-2 py-1 font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">
                      Not applicable
                    </span>
                  ) : (
                    <span className="rounded-md border border-ledger/40 bg-ledger/10 px-2 py-1 font-mono text-[9.5px] tracking-wide text-ledger uppercase">
                      Confirmed
                    </span>
                  )
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => confirm(key)}
                      className="rounded-md border border-ink/15 bg-panel px-2.5 py-1.5 text-[12px] font-semibold disabled:opacity-60"
                    >
                      Confirm
                    </button>
                    {canBeNotApplicable ? (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => notApplicable(key)}
                        className="cursor-pointer font-mono text-[9.5px] tracking-wide text-ink-faint uppercase underline-offset-2 hover:underline disabled:opacity-60"
                      >
                        not applicable
                      </button>
                    ) : null}
                  </>
                )}
              </span>
            </div>
          );
        })}
        <div className="flex items-center gap-2.5 border-t border-ink/10 px-5 py-3">
          <span className="flex-1 font-mono text-[9.5px] tracking-wide text-ink-faint uppercase">
            Locale en-GB · Europe/London · GBP set from your signup. Every confirm is a stamped write to Settings → General, on The Record.
          </span>
          {confirmableRemaining.length > 0 ? (
            <button
              type="button"
              disabled={pending}
              onClick={confirmAllRemaining}
              title="Only rows already holding a visible value — empty rows need an entry or an explicit not-applicable"
              className="rounded-md border border-ink/15 bg-panel px-3 py-1.5 text-[12.5px] font-semibold disabled:opacity-60"
            >
              Confirm all remaining ({confirmableRemaining.length})
            </button>
          ) : null}
          <button
            type="button"
            className="rounded-md bg-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-white"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
