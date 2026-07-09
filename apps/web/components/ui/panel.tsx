import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The mockup's `.panelbox`: a glass panel with a monospace register header.
 * The header face never changes between themes — it is the register.
 */
export function Panel({
  title,
  children,
  className,
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("glass overflow-hidden rounded-xl", className)}>
      <h2 className="border-b border-rule px-4 py-3 font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-soft uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}
