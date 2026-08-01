"use client";

import { useState } from "react";

import { canonicalOrigin } from "@/lib/app-url";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

/**
 * The two doors (Session 5: Google; Session 20: Microsoft) — one component so
 * a click on either disables both, and the redirect target rides the same
 * canonical seam (Session 18): NEXT_PUBLIC_APP_URL when set, the current
 * origin otherwise. Only the Supabase redirect allowlist needs to know a new
 * host.
 *
 * Equal weight is the ruled shape (Session 20): same chrome, same size, the
 * provider mark the only difference. Signing in through either door grants
 * nothing by itself — the allowlist and RLS decide, provider-blind, and an
 * allowed email is one account whichever door it walks through (Supabase
 * links a verified same-email identity to the existing user).
 */

type Provider = "google" | "azure";

export function OAuthSignInButtons() {
  const [pending, setPending] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function signIn(provider: Provider) {
    setPending(provider);
    setError(null);
    const supabase = createSupabaseBrowserClient();
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${canonicalOrigin(window.location.origin)}/auth/callback`,
        // Azure needs the email scope explicitly so the identity carries the
        // address the allowlist reads; Google's defaults already include it.
        ...(provider === "azure" ? { scopes: "email" } : {}),
      },
    });
    if (oauthError) {
      setError("Sign-in could not be started. Please try again.");
      setPending(null);
    }
    // On success the browser navigates away to the provider.
  }

  const buttonClass =
    "glass flex w-full items-center justify-center gap-2.5 rounded-lg px-5 py-2.5 text-[14px] font-semibold text-ink transition-colors hover:border-ledger disabled:opacity-60";

  return (
    <div className="flex w-[240px] flex-col items-stretch gap-3">
      <button
        type="button"
        onClick={() => signIn("google")}
        disabled={pending !== null}
        className={buttonClass}
      >
        <svg viewBox="0 0 48 48" className="size-4 shrink-0" aria-hidden="true">
          <path
            fill="#EA4335"
            d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
          />
          <path
            fill="#4285F4"
            d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
          />
          <path
            fill="#FBBC05"
            d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
          />
          <path
            fill="#34A853"
            d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
          />
        </svg>
        {pending === "google" ? "Opening Google…" : "Sign in with Google"}
      </button>
      <button
        type="button"
        onClick={() => signIn("azure")}
        disabled={pending !== null}
        className={buttonClass}
      >
        <svg viewBox="0 0 23 23" className="size-4 shrink-0" aria-hidden="true">
          <rect x="1" y="1" width="10" height="10" fill="#F25022" />
          <rect x="12" y="1" width="10" height="10" fill="#7FBA00" />
          <rect x="1" y="12" width="10" height="10" fill="#00A4EF" />
          <rect x="12" y="12" width="10" height="10" fill="#FFB900" />
        </svg>
        {pending === "azure" ? "Opening Microsoft…" : "Sign in with Microsoft"}
      </button>
      {error ? <p className="text-[13px] text-stamp">{error}</p> : null}
    </div>
  );
}
