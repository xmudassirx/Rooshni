import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { runWorkflowTick } from "@rooshni/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The workflow tick — Vercel-invocable (Vercel Cron calls GET with
 * `Authorization: Bearer $CRON_SECRET`). Cron-safe and idempotent: claims are
 * atomic and run starts are keyed, so overlapping invocations re-do nothing.
 *
 * FAIL CLOSED: without CRON_SECRET configured the endpoint does nothing, and
 * nothing short of the exact bearer token runs a tick. This route sits
 * outside the session middleware only because a cron holds no session — every
 * act the tick performs remains gated in the database (grants, human stamp,
 * state machine), which is the actual control.
 */

function authorised(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function tick(request: NextRequest): Promise<NextResponse> {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json(
      { ok: false, detail: "CRON_SECRET is not configured — the tick endpoint is closed." },
      { status: 503 }
    );
  }
  if (!authorised(request)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    return NextResponse.json(
      { ok: false, detail: "Supabase environment variables are not set." },
      { status: 503 }
    );
  }

  const db = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const report = await runWorkflowTick(db);
  return NextResponse.json({ ok: report.errors.length === 0, report });
}

export async function GET(request: NextRequest) {
  return tick(request);
}

export async function POST(request: NextRequest) {
  return tick(request);
}
