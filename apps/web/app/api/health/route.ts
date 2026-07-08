import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

/**
 * Deployment health check: confirms the app can reach the Supabase database.
 * Returns row counts only — never data, never configuration values.
 */
export async function GET() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!url || !secretKey) {
    return NextResponse.json(
      {
        ok: false,
        database: "not_configured",
        detail: "Supabase environment variables are not set.",
      },
      { status: 503 }
    );
  }

  const supabase = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { count, error } = await supabase
    .from("businesses")
    .select("*", { count: "exact", head: true });

  if (error) {
    return NextResponse.json(
      { ok: false, database: "unreachable", detail: error.message },
      { status: 503 }
    );
  }

  return NextResponse.json({
    ok: true,
    database: "connected",
    businesses: count ?? 0,
  });
}
