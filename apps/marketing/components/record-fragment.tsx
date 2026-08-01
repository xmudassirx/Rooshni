/**
 * A rendered fragment of The Record — the site's signature element. It quotes
 * the product's colour taxonomy because the taxonomy is the story: gold means
 * Light acted, red means a human stamped, green means done. The rows depict a
 * true product sequence (ingest, draft, stamp, dispatch), not a live feed.
 */
const ROWS: Array<{
  time: string;
  act: string;
  detail: string;
  tone?: "light" | "stamp" | "done";
}> = [
  { time: "09:02", act: "enquiry.received", detail: "new enquiry, Meta lead form" },
  {
    time: "09:02",
    act: "light.draft_created",
    detail: "reply drafted from your firm's own knowledge",
    tone: "light",
  },
  {
    time: "09:02",
    act: "compliance.checked",
    detail: "no guarantees, no case-specific advice, no unpublished fees",
    tone: "light",
  },
  {
    time: "09:11",
    act: "communication.approved",
    detail: "your stamp, the exact words you read",
    tone: "stamp",
  },
  { time: "09:11", act: "communication.sent", detail: "delivered as your firm", tone: "done" },
];

export function RecordFragment() {
  return (
    <figure style={{ margin: 0 }}>
      <div className="ledger" role="img" aria-label="A fragment of The Record: an enquiry arrives, Light drafts and checks a reply, a human approves it, the reply is sent.">
        <div className="ledger-head">
          <span>The Record</span>
          <span>one enquiry, one morning</span>
        </div>
        {ROWS.map((row) => (
          <div
            key={row.act}
            className={`ledger-row${row.tone ? ` is-${row.tone}` : ""}`}
          >
            <span className="ledger-time">{row.time}</span>
            <span>
              <span className="ledger-act">{row.act}</span>
              <span className="muted"> · {row.detail}</span>
            </span>
          </div>
        ))}
      </div>
      <figcaption className="legend" style={{ marginTop: "0.9rem" }}>
        <span>
          <span className="legend-swatch" style={{ background: "var(--gold)" }} />
          gold: Light acted
        </span>
        <span>
          <span className="legend-swatch" style={{ background: "var(--red)" }} />
          red: a human approved
        </span>
        <span>
          <span className="legend-swatch" style={{ background: "var(--green)" }} />
          green: done
        </span>
      </figcaption>
    </figure>
  );
}
