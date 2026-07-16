import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/*
 * Status chips per the mockup. The semantic variants are law in every theme:
 * gold = Light acted · red = human stamp required · green = done.
 */
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1 rounded px-1.5 py-px font-mono text-[10px] font-semibold tracking-wide uppercase [&>svg]:size-3",
  {
    variants: {
      variant: {
        gold: "border border-[#e5d2a4] bg-gold-tint text-gold",
        red: "border border-[#e8bcb2] bg-stamp-tint text-stamp",
        green: "border border-ledger-line bg-ledger-tint text-ledger",
        // Kind chips are chrome (decision 61) — the source chip follows the accent.
        source: "border border-accent bg-accent-tint text-accent",
        time: "border border-dashed border-rule bg-transparent text-ink-faint normal-case",
        warn: "border border-dashed border-amber bg-transparent text-amber normal-case",
        pending: "border border-dashed border-ink-faint bg-transparent text-ink-faint",
      },
    },
    defaultVariants: {
      variant: "time",
    },
  }
);

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span";

  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
