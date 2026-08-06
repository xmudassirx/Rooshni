import { formatWhen } from "@/lib/format";

/**
 * The Record renders events as plain English for humans; the structure stays
 * in the database for machines. Known verbs get a proper sentence; anything
 * unrecognised falls back to the verb itself, humanised — the screen must
 * never hide an entry it does not understand.
 */
export function describeEvent(action: string, payload: Record<string, unknown>): string {
  const str = (key: string): string | null =>
    typeof payload[key] === "string" ? (payload[key] as string) : null;

  switch (action) {
    case "contact.created": {
      const name = str("display_name");
      const source = str("source");
      return [
        name ? `new contact ${name}` : "new contact recorded",
        source === "meta_lead_ads" ? "arrived from a Meta lead form, consent recorded per channel" : null,
      ]
        .filter(Boolean)
        .join(" — ");
    }
    case "engagement.created": {
      const attribution = (payload.attribution ?? {}) as Record<string, unknown>;
      const source = typeof attribution.source === "string" ? attribution.source : null;
      const stage = str("stage");
      return [
        "enquiry opened",
        stage ? `at stage "${stage.replace(/_/g, " ")}"` : null,
        source ? `· source ${source === "meta" ? "Meta" : source}` : null,
      ]
        .filter(Boolean)
        .join(" ");
    }
    // Session 27 (D158): the returning-leads vocabulary.
    case "engagement.resubmission_received": {
      const form = str("form_label");
      const changed = Array.isArray(payload.changed) ? payload.changed.length : 0;
      return [
        "the client submitted the form again",
        form ? `— ${form}` : null,
        changed > 0 ? `· ${changed} detail${changed === 1 ? "" : "s"} changed` : "· no details changed",
      ]
        .filter(Boolean)
        .join(" ");
    }
    case "engagement.successor_opened":
      return "a returning submission opened a newer enquiry — linked below";
    case "engagement.opened_from_predecessor":
      return "opened by a returning submission — the previous enquiry is linked";
    case "communication.returning_marker_posted": {
      const form = str("form_label");
      return `system marker posted into the conversation${form ? ` — ${form}` : ""}`;
    }
    // Session 28 (D174b): enrichment — a returning submission's new value.
    case "contact.channel_added": {
      const channel = str("channel");
      const value = str("value");
      return [
        `returning submission added a new ${channel ?? "channel"}`,
        value ? `— ${value}` : null,
        "· consent carried from the form",
      ]
        .filter(Boolean)
        .join(" ");
    }
    // Session 30 (177c): the owner's archive — resolution and consent end,
    // history stands.
    case "contact.archived": {
      const reason = str("reason");
      return [
        "contact archived — leaves resolution, channels leave consent; history stands",
        reason ? `— “${reason}”` : null,
      ]
        .filter(Boolean)
        .join(" ");
    }
    // Session 27 (D161): route classification, every source honestly named.
    case "engagement.route_set": {
      const route = str("route");
      const routeSource = str("source");
      const reason = str("reason");
      const sourceLine =
        routeSource === "light"
          ? "set by Light"
          : routeSource === "human"
            ? "reclassified by hand"
            : routeSource === "form_answer"
              ? "from the form's own answer"
              : "per-form default";
      return [
        `route set${route ? ` → ${route.replace(/_/g, " ")}` : ""}`,
        `· ${sourceLine}`,
        reason ? `— “${reason}”` : null,
      ]
        .filter(Boolean)
        .join(" ");
    }
    case "engagement.stage_changed": {
      const to = str("to_stage_key") ?? str("to_stage");
      const auto = str("reason") === "first_outbound_dispatched";
      // Session 30 (177f): a human move names its hand and its reason.
      const human = str("source") === "human";
      const reason = human ? str("reason") : null;
      return [
        "stage moved" + (to ? ` → ${to.replace(/_/g, " ")}` : ""),
        auto ? "— first outbound reached the client (the template's transition law)" : null,
        human ? "· moved by hand" : null,
        reason ? `— “${reason}”` : null,
      ]
        .filter(Boolean)
        .join(" ");
    }
    case "template.installed": {
      const note = str("note");
      return note ?? "vertical template installed — stages, vocabulary and no-go rules now render from it";
    }
    case "settings.updated": {
      const key = str("key");
      return `settings confirmed${key ? ` — ${key.replace(/_/g, " ")}` : ""} · a human stamp, on the record`;
    }
    case "first_light.predicate_satisfied": {
      const key = str("predicate_key");
      return `First Light tick earned${key ? ` — ${key.replace(/_/g, " ")}` : ""}`;
    }
    case "first_light.row_skipped": {
      const reason = str("reason");
      return "First Light optional row skipped" + (reason ? ` — "${reason}"` : "");
    }
    case "first_light.completed":
      return "First Light complete — every tick earned; the pill has retired itself";
    case "task.created": {
      const due = str("due_at");
      return "task created" + (due ? ` · due ${formatWhen(due)}` : "");
    }
    case "communication.drafted": {
      const channel = str("channel");
      return `${channel ?? "message"} draft prepared — every send needs a human stamp`;
    }
    case "communication.submitted":
      return "draft submitted for approval — awaiting the stamp";
    // Session 25 (founder-ordered fail-loud): the refusal carries its
    // RECORDED reason — never invented, never summarised.
    case "light.draft_generation_failed": {
      const reason = str("reason");
      return "Light's draft was refused" + (reason ? `: ${reason}` : " — no reason recorded");
    }
    case "light.draft_register_retried": {
      const violation = str("violation");
      return (
        "register slip caught — Light redrafted once with the violation fed back" +
        (violation ? ` (${violation})` : "")
      );
    }
    case "communication.approved":
      return "communication approved — the human stamp, recorded forever";
    case "communication.rejected": {
      const reason = str("reason");
      return (
        "draft rejected and returned to Light's queue" + (reason ? ` — "${reason}"` : "")
      );
    }
    case "grant.issued": {
      const tool = str("tool");
      const access = str("access");
      const duration = str("duration");
      return [
        "permission granted",
        tool && access ? `— ${tool} · ${access}` : null,
        duration ? `· ${duration}` : null,
      ]
        .filter(Boolean)
        .join(" ");
    }
    case "grant.revoked":
      return "permission revoked";
    // Session 30 (177d): a cancelled run says why — "enquiry disqualified"
    // when the human stage move stood it down.
    case "workflow.run_cancelled": {
      const reason = str("reason");
      return `workflow run cancelled${reason ? ` — ${reason}` : ""}`;
    }
    default:
      // "workflow.run_started" → "workflow run started"
      return action.replace(".", " ").replace(/_/g, " ");
  }
}

/** "✦ 3 credits" when the event carried a metered cost. */
export function costLabel(cost: { credits?: number; tokens?: number } | null): string | null {
  if (!cost) return null;
  if (typeof cost.credits === "number") {
    return `✦ ${cost.credits} credit${cost.credits === 1 ? "" : "s"}`;
  }
  if (typeof cost.tokens === "number") {
    return `✦ ${cost.tokens} tokens`;
  }
  return "✦ metered";
}
