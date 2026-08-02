"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { classifyCommChange, rejoinDelayMs, shouldRejoin } from "@/lib/live-inbox-rules";

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
    /*
     * Defect-trio hotfix (2 Aug 2026, item 1): the s16 shape joined the
     * channel ONCE with whatever auth state existed at mount, watched no
     * channel status, and never re-authenticated the socket — so an
     * unauthenticated join, an expired JWT or a dropped rejoin left a DEAD
     * channel that delivered nothing and raised nothing, and the sidebar
     * badge missed drafts entering pending_approval until a manual refresh.
     * The lifecycle now: (a) setAuth BEFORE every join, so the RLS-checked
     * subscription always carries the signed-in claims; (b) the subscribe
     * status is WATCHED — a dead channel rejoins with capped backoff, and a
     * successful (re)join reconciles once via router.refresh in case
     * anything landed while dead; (c) auth refreshes re-arm the socket; (d)
     * returning to the tab reconciles once (event-driven, not a polling
     * loop — the s16 "Realtime only" rule holds).
     */
    const db = createSupabaseBrowserClient();
    let disposed = false;
    let generation = 0;
    let channel: ReturnType<typeof db.channel> | null = null;
    let rejoinTimer: number | null = null;
    let attempt = 0;

    const scheduleRefresh = () => {
      if (refreshTimer.current !== null) return;
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = null;
        router.refresh();
      }, 400);
    };

    const join = async () => {
      if (disposed) return;
      const mine = ++generation;
      const {
        data: { session },
      } = await db.auth.getSession();
      if (disposed || mine !== generation) return;
      if (session?.access_token) db.realtime.setAuth(session.access_token);
      if (channel) {
        void db.removeChannel(channel);
        channel = null;
      }
      channel = db
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
            // The single subtle tone — the PURE rules module decides (proven
            // in the live-inbox smoke); the same Appearance toggle governs.
            if (classifyCommChange(payload.eventType, next, prev).tone && soundEnabled()) {
              playArrivalTone();
            }
            // Session 23 (WS2, 5c): the open Conversations thread appends the
            // arriving row WITHOUT a refetch — the payload carries the row.
            // The debounced server refresh below stays as reconciliation
            // (every read it triggers is windowed since s22/s23; JUDGMENT:
            // append-first + bounded reconcile is the honest reading of
            // "Realtime appends without refetch").
            window.dispatchEvent(
              new CustomEvent("rooshni:comm-change", {
                detail: { eventType: payload.eventType, row: payload.new },
              })
            );
            scheduleRefresh();
          }
        )
        .subscribe((status) => {
          if (disposed || mine !== generation) return;
          if (status === "SUBSCRIBED") {
            attempt = 0;
            // Anything that landed while the channel was down is on the
            // server already — one reconciling render closes the gap.
            scheduleRefresh();
            return;
          }
          if (shouldRejoin(status)) {
            if (rejoinTimer !== null) window.clearTimeout(rejoinTimer);
            rejoinTimer = window.setTimeout(() => void join(), rejoinDelayMs(attempt++));
          }
        });
    };
    void join();

    // A refreshed session must reach the SOCKET — WALRUS checks the claims
    // per delivery, and hour-old claims silently deliver nothing.
    const {
      data: { subscription: authSub },
    } = db.auth.onAuthStateChange((_event, session) => {
      if (session?.access_token) db.realtime.setAuth(session.access_token);
    });

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") scheduleRefresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      disposed = true;
      generation += 1;
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
      if (rejoinTimer !== null) window.clearTimeout(rejoinTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      authSub.unsubscribe();
      if (channel) void db.removeChannel(channel);
    };
  }, [businessId, router]);

  return null;
}
