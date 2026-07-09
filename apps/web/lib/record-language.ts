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
    case "engagement.stage_changed":
      return "stage moved" + (str("to_stage_key") ? ` → ${str("to_stage_key")!.replace(/_/g, " ")}` : "");
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
