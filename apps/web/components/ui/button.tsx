import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-lg text-[13px] font-semibold whitespace-nowrap transition-transform active:scale-[.98] disabled:pointer-events-none disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-ledger/40 [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "glass text-ink hover:border-ledger",
        primary: "bg-ledger text-white border border-ledger shadow-panel hover:opacity-95",
        approve: "bg-stamp text-white border border-stamp shadow-panel hover:opacity-95",
        gold: "bg-gold text-white border border-gold shadow-panel hover:opacity-95",
        ghost: "text-ink-soft hover:text-ink hover:bg-paper-deep",
      },
      size: {
        default: "px-3.5 py-2",
        sm: "px-3 py-1.5 text-xs",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
