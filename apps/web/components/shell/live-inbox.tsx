"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

/*
 * Session 16 (PR-G) — the live inbox. ONE Supabase Realtime subscription on
 * the business's communications rows (no polling loops; Realtime only):
 * any change rings the doorbell and the app re-renders server-side
 * (router.refresh()), so the sidebar count, the inbox list and the open
 * Conversations thread all update from the same server-fed truth. A new
 * pending draft additionally plays a single subtle tone — user-toggleable
 * in Settings → Appearance (default ON), honestly deferring to the
 * browser's autoplay rules: before the first user interaction the tone
 * simply does not play, and that is fine and expected.
 */

export const INBOX_SOUND_STORAGE_KEY = "ui-inbox-sound";

function soundEnabled(): boolean {
  try {
    return localStorage.getItem(INBOX_SOUND_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

/** One subtle two-note chime, synthesised — no asset, no loop, no repeat. */
function playArrivalTone() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    if (ctx.state === "suspended") {
      // Autoplay rules: no user gesture yet — no sound, honestly.
      void ctx.close();
      return;
    }
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
    gain.connect(ctx.destination);
    const note = (freq: number, at: number) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, ctx.currentTime + at);
      osc.connect(gain);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + 0.35);
    };
    note(830, 0);
    note(1108, 0.12);
    window.setTimeout(() => void ctx.close(), 900);
  } catch {
    // A sound failure is never an error worth surfacing.
  }
}

export function LiveInbox({ businessId }: { businessId: string }) {
  const router = useRouter();
  const refreshTimer = useRef<number | null>(null);

  useEffect(() => {
    const db = createSupabaseBrowserClient();
    const scheduleRefresh = () => {
      if (refreshTimer.current !== null) return;
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = null;
        router.refresh();
      }, 400);
    };

    const channel = db
      .channel(`communications-${businessId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "communications",
          filter: `business_id=eq.${businessId}`,
        },
        (payload) => {
          const next = payload.new as { status?: string; direction?: string } | null;
          const prev = payload.old as { status?: string } | null;
          // The single subtle tone: a draft ARRIVING at pending (a stamp
          // newly owed) — not edits, not decisions. Session 23 (WS1c,
          // founder-ruled): an INBOUND client message rings the same tone,
          // governed by the same Appearance toggle.
          const draftArrived =
            next?.status === "pending_approval" && prev?.status !== "pending_approval";
          const inboundArrived =
            payload.eventType === "INSERT" && next?.direction === "inbound";
          if ((draftArrived || inboundArrived) && soundEnabled()) {
            playArrivalTone();
          }
          scheduleRefresh();
        }
      )
      .subscribe();

    return () => {
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
      void db.removeChannel(channel);
    };
  }, [businessId, router]);

  return null;
}
