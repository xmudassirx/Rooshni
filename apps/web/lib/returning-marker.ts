/*
 * Session 27 (D158a): the returning-lead system marker's structured facts,
 * defensively parsed from a communications row's attributes. PURE and
 * dependency-free — shared by the server read layer, the client thread view
 * and the check-local harness (the live-inbox-rules precedent).
 */

export interface ReturningMarkerFacts {
  formLabel: string | null;
  submittedAt: string | null;
  answers: Array<{ label: string; value: string; previousValue: string | null; changed: boolean }>;
}

export const RETURNING_MARKER_KIND = "returning_lead_marker";

export function parseReturningMarker(
  kind: string | null | undefined,
  marker: unknown
): ReturningMarkerFacts | null {
  if (kind !== RETURNING_MARKER_KIND) return null;
  const m = (marker ?? {}) as { form_label?: unknown; submitted_at?: unknown; answers?: unknown };
  const answers = Array.isArray(m.answers)
    ? m.answers.flatMap((a) => {
        if (!a || typeof a !== "object") return [];
        const row = a as { label?: unknown; value?: unknown; previous_value?: unknown; changed?: unknown };
        return [
          {
            label: typeof row.label === "string" ? row.label : "",
            value: typeof row.value === "string" ? row.value : "",
            previousValue: typeof row.previous_value === "string" ? row.previous_value : null,
            changed: row.changed === true,
          },
        ];
      })
    : [];
  return {
    formLabel: typeof m.form_label === "string" ? m.form_label : null,
    submittedAt: typeof m.submitted_at === "string" ? m.submitted_at : null,
    answers,
  };
}
