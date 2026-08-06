"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/*
 * Session 30, Workstream C: the once-per-event archive confirmation on the
 * Contacts book — the shipped toast pattern (the Social ink pill), STATIC:
 * tier 3 may animate subtly, but the shipped pattern carries no motion and
 * this follows it exactly; nothing to declare for reduced motion. The URL
 * param clears itself after the moment passes, so a reload or share of the
 * book never replays the confirmation.
 */
export function ArchivedToast({ name }: { name: string }) {
  const router = useRouter();

  useEffect(() => {
    const t = window.setTimeout(() => router.replace("/contacts"), 4000);
    return () => window.clearTimeout(t);
  }, [router]);

  return (
    <span className="fixed bottom-5 left-1/2 z-100 w-max max-w-[92vw] -translate-x-1/2 rounded-lg bg-ink px-4 py-2.5 text-center text-[13px] text-paper shadow-[0_10px_30px_rgba(0,0,0,.3)]">
      {name} — Archived · on The Record
    </span>
  );
}
