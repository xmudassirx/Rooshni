import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@rooshni/db";

/** Browser Supabase client — sign-in flows only; all data access is server-side. */
export function createSupabaseBrowserClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set."
    );
  }
  return createBrowserClient(url, key) as SupabaseClient;
}
