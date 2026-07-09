import { redirect } from "next/navigation";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { GoogleSignInButton } from "./google-button";

export const dynamic = "force-dynamic";

/**
 * The sign-in door (Session 5). Google is the only provider. Signing in does
 * not grant anything by itself: the middleware lets a session through only
 * when its email is on the allowlist, and the tenancy wall behind that is
 * memberships + RLS.
 */
export default async function SignInPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    const { data: allowed } = await supabase
      .from("allowed_emails")
      .select("id")
      .limit(1);
    // Already in and allowlisted — straight to the app.
    if (allowed?.length) redirect("/");
    // Signed in but not allowlisted: the holding page, same as everywhere.
    redirect("/construction");
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-paper px-6 text-center">
      <div className="font-display text-3xl font-black tracking-tight text-ink">
        Rooshni
      </div>
      <div className="mt-1.5 font-mono text-[10px] tracking-[.18em] text-ink-faint uppercase">
        One database · many faces
      </div>
      <div className="mt-10">
        <GoogleSignInButton />
      </div>
      <p className="mt-6 max-w-[44ch] text-[12.5px] leading-relaxed text-ink-faint">
        Access is by invitation. If your account has not been invited, signing
        in will not open anything.
      </p>
    </div>
  );
}
