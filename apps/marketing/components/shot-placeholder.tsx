/**
 * Styled stand-in for a founder-supplied product screenshot. The exact
 * dimensions each slot needs are requested in the Session 17 close report;
 * the aspect ratio here matches so the layout does not shift when the real
 * capture lands.
 */
export function ShotPlaceholder({
  label,
  width,
  height,
}: {
  label: string;
  width: number;
  height: number;
}) {
  return (
    <div
      className="shot"
      style={{ aspectRatio: `${width} / ${height}` }}
      aria-label={`Screenshot placeholder: ${label}`}
    >
      <p>
        {label}
        <br />
        <span style={{ fontSize: "0.75rem" }}>
          screenshot to follow ({width} x {height})
        </span>
      </p>
    </div>
  );
}
