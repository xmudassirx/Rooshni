import * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "w-full min-h-24 resize-y rounded-lg border border-rule bg-paper px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-faint focus-visible:ring-2 focus-visible:ring-ledger/40 outline-none disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
}

export { Textarea };
