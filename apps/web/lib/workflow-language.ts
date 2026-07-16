import type { WorkflowStepRow } from "@/lib/server/queries";

/*
 * Rendering vocabulary for workflow data — the Automation list and the
 * generated canvas read the same step rows the runner executes. Timers are
 * DATA (real-world durations in step config, scaled by the runner through
 * timeScale()); this file only puts words on them.
 */

export function workflowTitle(key: string): string {
  const words = key.replace(/_/g, " ");
  const titled = words.charAt(0).toUpperCase() + words.slice(1);
  return titled.replace(/\bto\b/g, "→");
}

export function stepLabel(step: WorkflowStepRow): string {
  const base = step.key.replace(/_/g, " ");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function durationWords(d: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof d.days === "number") parts.push(`${d.days}d`);
  if (typeof d.hours === "number") parts.push(`${d.hours}h`);
  if (typeof d.minutes === "number") parts.push(`${d.minutes}m`);
  if (typeof d.seconds === "number") parts.push(`${d.seconds}s`);
  return parts.join(" ");
}

/** The timer column, straight from step config — nothing invented. */
export function stepTimer(step: WorkflowStepRow): string {
  const c = step.config;
  if (c.sla && typeof c.sla === "object") {
    return `within ${durationWords(c.sla as Record<string, unknown>)}`;
  }
  if (c.due && typeof c.due === "object") {
    return `due in ${durationWords(c.due as Record<string, unknown>)}`;
  }
  if (c.wait && typeof c.wait === "object") {
    return `wait ${durationWords(c.wait as Record<string, unknown>)}`;
  }
  if (Array.isArray(c.offsets)) {
    return (c.offsets as Record<string, unknown>[])
      .map((o) => `−${durationWords(o)}`)
      .join(" / ");
  }
  return "—";
}

/** The condition a step waits on, when its config names one. */
export function stepCondition(step: WorkflowStepRow): string | null {
  return typeof step.config.when === "string"
    ? step.config.when.replace(/_/g, " ")
    : null;
}

export function stepDetail(step: WorkflowStepRow): string {
  const bits: string[] = [];
  if (typeof step.config.template === "string") bits.push(`template ${step.config.template}`);
  if (typeof step.config.channel === "string") bits.push(step.config.channel);
  if (typeof step.config.stage === "string") bits.push(`stage → ${step.config.stage}`);
  if (step.config.cancel_on_reply === true) bits.push("a reply cancels it");
  return bits.join(" · ");
}

export function gateChip(step: WorkflowStepRow): { label: string; stamped: boolean } {
  const level = step.gateLevel ?? 0;
  const stamped = step.config.await_approval === true || (level >= 3 && step.kind === "draft_comm");
  return { label: stamped ? `L${level} stamp` : `L${level}`, stamped };
}

/** Node accent per kind — gold is Light's hand, green completes, red closes. */
export function kindGlyph(kind: string): { glyph: string; className: string } {
  switch (kind) {
    case "draft_comm":
      return { glyph: "✦", className: "light-avatar" };
    case "create_task":
      return { glyph: "☎", className: "bg-accent text-white" };
    case "branch":
      return { glyph: "⑃", className: "bg-ink text-white" };
    case "notify":
      return { glyph: "◷", className: "bg-ledger text-white" };
    case "wait":
      return { glyph: "…", className: "bg-paper-deep text-ink-soft border border-rule" };
    case "close":
      return { glyph: "✕", className: "bg-stamp text-white" };
    default:
      return { glyph: "•", className: "bg-paper-deep text-ink-soft border border-rule" };
  }
}
