"use server";

import { redirect } from "next/navigation";
import { createServiceClient, createAuthorizationCode, McpRefusal } from "@rooshni/db";
import { getAppContext } from "@/lib/server/context";

/**
 * The consent acts for the OAuth authorise page (Session 34). Both run
 * behind the session gate: getAppContext() throws a stranger out before
 * anything else happens. Approval requires the MINTED CREDENTIAL pasted by
 * the founder — a signed-in session alone authorises nothing (the
 * credential, not the cookie, is the key the connector keeps).
 */
export async function approveConnectionAction(formData: FormData): Promise<void> {
  await getAppContext();

  const credentialSecret = String(formData.get("credential") ?? "").trim();
  const clientId = String(formData.get("client_id") ?? "");
  const redirectUri = String(formData.get("redirect_uri") ?? "");
  const state = String(formData.get("state") ?? "");
  const codeChallenge = String(formData.get("code_challenge") ?? "");
  const codeChallengeMethod = String(formData.get("code_challenge_method") ?? "");

  let code: string;
  try {
    const result = await createAuthorizationCode(createServiceClient(), {
      credentialSecret,
      clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
    });
    code = result.code;
  } catch (error) {
    if (error instanceof McpRefusal) {
      const back = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: codeChallengeMethod,
        response_type: "code",
        refused: error.message,
      });
      redirect(`/oauth/authorize?${back.toString()}`);
    }
    throw error;
  }

  const target = new URL(redirectUri);
  target.searchParams.set("code", code);
  if (state) target.searchParams.set("state", state);
  redirect(target.toString());
}

export async function denyConnectionAction(formData: FormData): Promise<void> {
  await getAppContext();

  const redirectUri = String(formData.get("redirect_uri") ?? "");
  const state = String(formData.get("state") ?? "");

  let target: URL;
  try {
    target = new URL(redirectUri);
  } catch {
    redirect("/");
  }
  target!.searchParams.set("error", "access_denied");
  if (state) target!.searchParams.set("state", state);
  redirect(target!.toString());
}
