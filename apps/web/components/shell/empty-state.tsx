import type { ReactNode } from "react";

/*
 * True empty states (Session 11; mockup: onboarding-wizard Pass 4 v2).
 * Each one teaches its surface: what fills it, by which door, under which
 * gate — and never invents a number or claims a reading that never happened.
 */

export function EmptyState({
  icon,
  title,
  action,
  children,
}: {
  icon: string;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="glass mx-auto mt-9 max-w-[560px] rounded-2xl border-dashed p-8 text-center">
      <div className="mb-2 text-[28px]">{icon}</div>
      <h3 className="mb-1.5 font-display text-[19px] font-extrabold">{title}</h3>
      <div className="mx-auto flex max-w-[46ch] flex-col gap-1.5 text-[13.5px] text-ink-soft">
        {children}
      </div>
      {action ? <div className="mt-3.5">{action}</div> : null}
    </div>
  );
}
