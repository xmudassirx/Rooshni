"use client";

import { useState } from "react";

import { Button, type buttonVariants } from "@/components/ui/button";
import type { VariantProps } from "class-variance-authority";

/**
 * A drawn control whose action belongs to a later session. It renders exactly
 * as the mockup draws it and, when pressed, says plainly what would happen and
 * when it arrives — never a fake success, never a dead button.
 */
export function HonestButton({
  notice,
  children,
  variant,
  size,
  className,
}: {
  notice: string;
  children: React.ReactNode;
  className?: string;
} & VariantProps<typeof buttonVariants>) {
  const [shown, setShown] = useState(false);
  function show() {
    setShown(true);
    window.setTimeout(() => setShown(false), 3600);
  }
  return (
    <span className={className}>
      <Button variant={variant} size={size} onClick={show}>
        {children}
      </Button>
      {shown ? (
        <span className="fixed bottom-5 left-1/2 z-100 w-max max-w-[92vw] -translate-x-1/2 rounded-lg bg-ink px-4 py-2.5 text-center text-[13px] text-paper shadow-[0_10px_30px_rgba(0,0,0,.3)]">
          {notice}
        </span>
      ) : null}
    </span>
  );
}
