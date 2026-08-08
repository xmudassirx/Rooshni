import type { Metadata } from "next";
import { getAppContext } from "@/lib/server/context";
import { Button } from "@/components/ui/button";
import { approveConnectionAction, denyConnectionAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Authorise connection",
};

/**
 * The OAuth authorise page (Session 34, founder rider 2): honest consent in
 * the product's own register, behind the existing session gate. The pasted
 * MINTED CREDENTIAL is the authority — a session alone approves nothing.
 *
 * Register: PRODUCT chrome. Standalone page (no app shell), bg-paper like
 * the sign-in door; heading in the display face; the what-this-grants line
 * in the register face (mono metadata). The primary act wears the accent
 * (chrome follows the user's accent, decision 61) — red stays the stamp of
 * outbound work and never this button.
 */
export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { business } = await getAppContext();
  const params = await searchParams;
  const p = (key: string): string => {
    const v = params[key];
    return typeof v === "string" ? v : "";
  };

  const clientId = p("client_id");
  const redirectUri = p("redirect_uri");
  const state = p("state");
  const codeChallenge = p("code_challenge");
  const codeChallengeMethod = p("code_challenge_method") || "S256";
  const responseType = p("response_type");
  const refused = p("refused");

  const requestValid =
    responseType === "code" &&
    clientId !== "" &&
    /^https:\/\//.test(redirectUri) &&
    codeChallenge !== "" &&
    codeChallengeMethod === "S256";

  let redirectHost = "";
  try {
    redirectHost = new URL(redirectUri).host;
  } catch {
    redirectHost = "";
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-paper px-6">
      <div className="glass w-full max-w-md rounded-xl border border-panel-border p-8 shadow-panel">
        <div className="font-display text-lg font-extrabold tracking-tight text-ink">
          Authorise connection
        </div>

        {!requestValid ? (
          <p className="mt-4 text-[13px] leading-relaxed text-ink-soft">
            This authorisation request is incomplete or malformed. Close this
            page and start the connection again from your Claude client.
          </p>
        ) : (
          <>
            <p className="mt-4 text-[13px] leading-relaxed text-ink-soft">
              An AI client{redirectHost ? ` at ${redirectHost}` : ""} is asking
              to connect to {business.name}.
            </p>

            <div className="mt-4 rounded-lg bg-paper-deep px-4 py-3 font-mono text-[11px] leading-relaxed tracking-[0.02em] text-ink-soft">
              READ-ONLY ACCESS TO {business.name.toUpperCase()} AS THE ACTOR
              &lsquo;CLAUDE VIA MCP&rsquo;. EVERY CALL LANDS ON THE RECORD. NO
              STAMPING, NO DRAFTING, NO STAGE MOVES, NO MEMORY WRITES.
            </div>

            {refused ? (
              <p className="mt-4 text-[12.5px] leading-relaxed text-stamp">
                {refused}
              </p>
            ) : null}

            <form action={approveConnectionAction} className="mt-6 space-y-4">
              <input type="hidden" name="client_id" value={clientId} />
              <input type="hidden" name="redirect_uri" value={redirectUri} />
              <input type="hidden" name="state" value={state} />
              <input type="hidden" name="code_challenge" value={codeChallenge} />
              <input
                type="hidden"
                name="code_challenge_method"
                value={codeChallengeMethod}
              />
              <div>
                <label
                  htmlFor="credential"
                  className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-soft"
                >
                  Minted credential
                </label>
                <input
                  id="credential"
                  name="credential"
                  type="password"
                  required
                  autoComplete="off"
                  placeholder="barakah_mcp_…"
                  className="mt-1.5 w-full rounded-md border border-rule bg-panel px-3 py-2 font-mono text-[12.5px] text-ink outline-none focus:ring-2 focus:ring-accent"
                />
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-faint">
                  Paste the credential minted in Settings, Integrations. It was
                  shown once at mint; if it is lost, revoke and mint again.
                </p>
              </div>
              <Button type="submit" variant="primary" className="w-full">
                Authorise read-only access
              </Button>
            </form>

            <form action={denyConnectionAction} className="mt-3">
              <input type="hidden" name="redirect_uri" value={redirectUri} />
              <input type="hidden" name="state" value={state} />
              <Button type="submit" variant="ghost" className="w-full">
                Refuse
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
