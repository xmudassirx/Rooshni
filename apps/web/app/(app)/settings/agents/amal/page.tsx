import Link from "next/link";

import { HonestButton } from "@/components/ui/honest-button";
import { getAgentActor, getMemberDetail } from "@/lib/server/queries";

export const dynamic = "force-dynamic";

/*
 * view-agentrole, master mockup v2: Amal — an agent role = skill + knowledge
 * pack + grants + routing rule (AMENDMENTS-PASS3). The role store, skills
 * and knowledge packs are later sessions, so those tiles read as
 * config-on-paper; the GRANTS panel reads the real grants rows of the agent
 * actor. The voice & model panel renders DISABLED and marked PHASE 3 WIRING,
 * exactly as the mockup does.
 */

const BRAIN_OPTIONS = [
  "Light Standard · included",
  "Light Pro · metered",
  "Claude · via router",
  "GPT · via router",
  "Gemini · via router",
];
const VOICE_PROVIDERS = ["ElevenLabs", "OpenAI voice", "Google voice"];
const VOICE_MODELS = [
  "Auto · picks best",
  "Multilingual V2 · slow, high quality",
  "V3 · multilingual, slowest, highest quality",
  "Flash V2.5 · multilingual, fastest, medium",
  "Flash V2 · English only, fastest, medium",
];

function DisabledSelect({ options, label }: { options: string[]; label: string }) {
  return (
    <select
      disabled
      aria-label={label}
      className="cursor-not-allowed rounded-md border border-rule bg-paper-deep px-2 py-1.5 font-mono text-[11px] text-ink-faint opacity-75"
    >
      {options.map((o) => (
        <option key={o}>{o}</option>
      ))}
    </select>
  );
}

export default async function AgentRolePage() {
  const agent = await getAgentActor();
  const detail = agent ? await getMemberDetail(agent.id) : null;

  return (
    <>
      <div className="mb-3.5">
        <Link
          href="/settings"
          className="font-mono text-xs font-semibold tracking-wide text-ink-soft hover:text-ink"
        >
          ← Back to Team &amp; Access
        </Link>
      </div>
      <div className="mb-4 flex flex-wrap items-end gap-3.5">
        <h1 className="font-display text-2xl font-extrabold tracking-tight">
          Amal — Spouse-visa intake
        </h1>
        <span className="pb-0.5 text-[13px] text-ink-soft">
          An agent role: Light wearing one skill and one knowledge filter · chat + email in
          Phase 2, voice bolts on in Phase 3
        </span>
        <div className="ml-auto">
          <HonestButton notice="Pause: enquiries route back to the human queue instantly — the role is a routing rule, not an employee to offboard. Routing wires with the role store's session.">
            Pause role
          </HonestButton>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 max-[760px]:grid-cols-1">
        <div className="glass rounded-lg px-3.5 py-3">
          <div className="font-mono text-[9.5px] tracking-[.12em] text-ink-faint uppercase">
            Skill
          </div>
          <div className="my-1 font-display text-[17px] font-extrabold">
            spouse-visa-intake · v1
          </div>
          <div className="text-[11.5px] leading-normal text-ink-soft">
            Seeded from your Amal prompt document — scripted intake, one question at a
            time, mandatory disclosure first.{" "}
            <i>On paper: the skill store arrives with its session.</i>
          </div>
        </div>
        <div className="glass rounded-lg px-3.5 py-3">
          <div className="font-mono text-[9.5px] tracking-[.12em] text-ink-faint uppercase">
            Knowledge pack
          </div>
          <div className="my-1 font-display text-[17px] font-extrabold">
            Spouse visa · UK Immigration
          </div>
          <div className="text-[11.5px] leading-normal text-ink-soft">
            The role answers ONLY from the pack — one source, every mouth; the ripple keeps
            it current. <i>On paper: knowledge packs arrive with their session.</i>
          </div>
        </div>
      </div>

      <div className="glass mb-4 overflow-hidden rounded-xl">
        <h2 className="border-b border-rule bg-paper px-4 py-3 font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-soft uppercase">
          Grants · the same chips as any member — read from the live grants rows
        </h2>
        <div className="flex flex-wrap gap-2 px-4 py-3.5">
          {detail?.grants.length ? (
            detail.grants.map((g, i) => (
              <span
                key={i}
                className="rounded-md border border-ledger-line bg-ledger-tint px-2 py-0.5 font-mono text-[10px] font-semibold text-ledger"
              >
                {g.tool} · {g.access}
              </span>
            ))
          ) : (
            <span className="text-[13px] text-ink-soft">
              No grants issued to {agent?.name ?? "the agent"} yet — chips appear here the
              moment grant rows exist.
            </span>
          )}
          <span
            className="rounded-md border border-dashed border-ink-faint bg-transparent px-2 py-0.5 font-mono text-[10px] font-semibold text-ink-faint"
            title="LEVEL 4 — FORBIDDEN. Advice requests deflect to booking, every time, by pre-flight rule — not by prompt hope. This is the IAA compliance line."
          >
            advise — forbidden
          </span>
        </div>
      </div>

      {/* PHASE 3 WIRING — drawn now so the role is complete on paper. */}
      <div className="glass mb-4 overflow-hidden rounded-xl opacity-90">
        <h2 className="border-b border-rule bg-paper px-4 py-3 font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-soft uppercase">
          Voice &amp; model · the brain and the mouth are picked per role — providers connect
          through the model router
        </h2>
        <div className="flex flex-col">
          {(
            [
              ["Brain (LLM)", <DisabledSelect key="b" label="Brain" options={BRAIN_OPTIONS} />, "routine intake runs Standard · escalation rules apply"],
              ["Voice provider", <DisabledSelect key="p" label="Voice provider" options={VOICE_PROVIDERS} />, "the mouth is a provider choice — the brain stays whatever you picked above"],
              ["Voice model", <DisabledSelect key="m" label="Voice model" options={VOICE_MODELS} />, "per-minute cost feeds the same credit caps"],
              ["Languages", null, "English · Urdu — matches the firm's language setting; the disclosure line plays in both"],
            ] as const
          ).map(([label, control, note]) => (
            <div
              key={label as string}
              className="grid grid-cols-[250px_1fr] items-center gap-5 border-b border-rule px-5 py-3.5 text-[13.5px] last:border-b-0 max-[720px]:grid-cols-1"
            >
              <b className="text-ink-soft">{label}</b>
              <span className="flex flex-wrap items-center gap-2.5 text-[12.5px] text-ink-faint">
                {control}
                {note}
              </span>
            </div>
          ))}
        </div>
        <p className="px-4 pb-3.5 font-mono text-[11px] text-ink-faint uppercase">
          Phase 3 wiring — config drawn now so the role is complete on paper. Brain and
          mouth are separate choices: the LLM thinks, the TTS speaks, the router bills both.
        </p>
      </div>

      <div className="glass mb-4 overflow-hidden rounded-xl">
        <h2 className="border-b border-rule bg-paper px-4 py-3 font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-soft uppercase">
          Routing rule · what sends an enquiry to this role
        </h2>
        {(
          [
            ["Trigger", "new enquiry · visa_route = spouse visa — on paper until the role store lands"],
            ["Channels", "web chat · email — voice arrives Phase 3"],
            ["Hand-off", "intake done → proposes stage move · doubts → human queue"],
          ] as const
        ).map(([k, v]) => (
          <div
            key={k}
            className="grid grid-cols-[250px_1fr] items-baseline gap-5 border-b border-rule px-5 py-3.5 text-[13.5px] last:border-b-0 max-[720px]:grid-cols-1"
          >
            <b>{k}</b>
            <span className="text-[12.5px] text-ink-soft">{v}</span>
          </div>
        ))}
      </div>

      <p className="font-mono text-xs text-ink-faint">
        INTAKE BY THIS ROLE IS SPEC 4 STEPS 2–5 WITH A DIFFERENT FACE — THE JUNK-FILTERING
        BUSINESS CASE. EVERY ANSWER IT RECORDS IS A PROPOSED FACT; EVERY BOOKING PASSES THE
        SLOT CHECK; EVERY UTTERANCE IS ON THE RECORD.
      </p>
    </>
  );
}
