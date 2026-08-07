/*
 * Lead-context micro-fix (7 Aug 2026, D186 session) — the panel's two
 * honest registers. A form answer byte-identical to a channel value
 * (case-insensitively equal for email) FOLDS into the channel line rather
 * than repeating; answers that differ still render verbatim. Pure, so the
 * harness proves the folding directly.
 */

export interface LeadContextAnswer {
  label: string;
  value: string;
}

export interface LeadContextChannel {
  channel: string;
  value: string;
  consented: boolean;
}

export interface FoldedLeadChannel extends LeadContextChannel {
  /** Labels of the form answers this channel line absorbed. */
  foldedAnswerLabels: string[];
}

export interface FoldedLeadContext {
  /** Answers that matched no channel value — rendered verbatim. */
  answers: LeadContextAnswer[];
  channels: FoldedLeadChannel[];
}

export function foldLeadContext(
  answers: LeadContextAnswer[],
  channels: LeadContextChannel[]
): FoldedLeadContext {
  const folded: FoldedLeadChannel[] = channels.map((c) => ({ ...c, foldedAnswerLabels: [] }));
  const kept: LeadContextAnswer[] = [];
  for (const answer of answers) {
    const matches = folded.filter((c) =>
      c.channel === "email"
        ? c.value.toLowerCase() === answer.value.toLowerCase()
        : c.value === answer.value
    );
    if (matches.length > 0) {
      for (const c of matches) c.foldedAnswerLabels.push(answer.label);
    } else {
      kept.push(answer);
    }
  }
  return { answers: kept, channels: folded };
}
