"use client";

/** Opens the First Light panel from anywhere in the shell — the pill listens
 * for this event, so surfaces never duplicate panel state. */
export function OpenFirstLightButton({ children }: { children: React.ReactNode }) {
  return (
    <button
      type="button"
      className="rounded-md bg-accent px-3.5 py-2 text-[13px] font-semibold text-white shadow-panel"
      onClick={() => window.dispatchEvent(new CustomEvent("first-light:open"))}
    >
      {children}
    </button>
  );
}
