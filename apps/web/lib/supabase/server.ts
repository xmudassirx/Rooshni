import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@rooshni/db";

/**
 * The user-scoped Supabase client (Session 5). Reads the signed-in user's
 * session from cookies, so every query runs under RLS as that user — the
 * database decides what they may see and do. This replaces the Session 4
 * service-client-as-owner arrangement (decision 23, retired).
 *
 * Cookie writes are attempted and swallowed in Server Components (Next.js
 * forbids them there); the middleware refreshes sessions, route handlers and
 * server actions may write.
 */
export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set."
    );
  }

  const cookieStore = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component — the middleware handles refresh.
        }
      },
    },
  }) as SupabaseClient;
}
