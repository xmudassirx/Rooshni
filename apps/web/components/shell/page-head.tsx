import type { ReactNode } from "react";

export function PageHead({
  title,
  sub,
  actions,
}: {
  title: string;
  sub?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end gap-3.5">
      <h1 className="font-display text-2xl font-extrabold tracking-tight">{title}</h1>
      {sub ? <span className="pb-0.5 text-[13px] text-ink-soft">{sub}</span> : null}
      {actions ? <div className="ml-auto flex gap-2">{actions}</div> : null}
    </div>
  );
}

/** Placeholder for surfaces that arrive in a later session. */
export function Placeholder({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="glass mx-auto mt-10 max-w-[560px] rounded-2xl border-dashed p-9 text-center">
      <div className="mb-2.5 text-3xl">{icon}</div>
      <h2 className="mb-2 font-display text-xl font-extrabold">{title}</h2>
      <p className="mx-auto max-w-[42ch] text-sm text-ink-soft">{children}</p>
      <span className="mt-3 inline-block rounded-md border border-ledger-line bg-ledger-tint px-3 py-1 font-mono text-[11px] font-semibold tracking-wide text-ledger uppercase">
        A later session
      </span>
    </div>
  );
}
