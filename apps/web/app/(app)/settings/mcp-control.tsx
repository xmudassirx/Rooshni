"use client";

import { useActionState, useState } from "react";
import {
  mintMcpCredentialAction,
  revokeMcpCredentialAction,
  type McpMintActionState,
  type McpRevokeActionState,
} from "./actions";
import type { McpRowState } from "@/lib/server/queries";

/*
 * Session 34 (D188c) — the MCP row's control inside Settings → Integrations
 * (one door, decision 58). Mint shows the credential ONCE, in the register
 * face, with the copy act beside it; revoke is permanent and closes the
 * door for every token bound to the credential. The connection chip is
 * EARNED by a recorded authenticated call (last_used_at), never assumed at
 * mint — the unearned-tick law. ACCENT carries the control chrome; green is
 * reserved for the earned connection state.
 */

const MINT_INITIAL: McpMintActionState = { error: null };
const REVOKE_INITIAL: McpRevokeActionState = { error: null };

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        });
      }}
      className="rounded-md border border-rule bg-paper px-2 py-1 font-mono text-[9.5px] tracking-wide text-ink-soft uppercase hover:border-accent hover:text-ink"
    >
      {copied ? "copied" : label}
    </button>
  );
}

export function McpControl({
  state: row,
  endpointUrl,
}: {
  state: McpRowState;
  endpointUrl: string;
}) {
  const [mintState, mintAction, mintPending] = useActionState(
    mintMcpCredentialAction,
    MINT_INITIAL
  );
  const [revokeState, revokeAction, revokePending] = useActionState(
    revokeMcpCredentialAction,
    REVOKE_INITIAL
  );
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const credential = row.credential;

  return (
    <div className="mt-2.5">
      <div className="mb-1 font-mono text-[9.5px] font-semibold tracking-[.14em] text-ink-faint uppercase">
        MCP · read-only AI client access
      </div>
      <div className="rounded-xl border-[1.5px] border-rule bg-paper px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-soft">
            {endpointUrl}
          </span>
          <CopyButton value={endpointUrl} label="copy url" />
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-soft">
          Add this URL as a custom connector in a Claude client, then paste the
          minted credential on the authorise page it opens. Every call reads as
          the actor {credential?.actorName ?? "Claude via MCP"} and lands on The
          Record. Read-only: no stamping, no drafting, no stage moves, no memory
          writes.
        </p>

        {mintState.secret ? (
          <div className="mt-2.5 rounded-lg border border-gold/40 bg-gold/10 px-3 py-2.5">
            <div className="font-mono text-[9.5px] font-semibold tracking-[.14em] text-gold uppercase">
              Credential · shown once
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <span className="min-w-0 flex-1 break-all font-mono text-[11.5px] text-ink">
                {mintState.secret}
              </span>
              <CopyButton value={mintState.secret} label="copy" />
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-soft">
              Stored hashed; this is the only time it renders. If it is lost,
              revoke and mint again.
            </p>
          </div>
        ) : null}

        {credential ? (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <span
              className={
                credential.lastUsedAt
                  ? "rounded-md border border-ledger/40 bg-ledger/10 px-2 py-1 font-mono text-[9.5px] tracking-wide text-ledger uppercase"
                  : "rounded-md border border-ink/15 bg-paper-deep px-2 py-1 font-mono text-[9.5px] tracking-wide text-ink-faint uppercase"
              }
            >
              {credential.lastUsedAt
                ? `connected · last used ${new Date(credential.lastUsedAt).toLocaleString("en-GB")}`
                : "minted · awaiting first call"}
            </span>
            <span className="font-mono text-[10px] text-ink-faint">
              minted {new Date(credential.createdAt).toLocaleDateString("en-GB")}
            </span>
            {row.isOwner ? (
              confirmRevoke ? (
                <form action={revokeAction} className="ml-auto flex items-center gap-2">
                  <input type="hidden" name="credential_id" value={credential.id} />
                  <span className="text-[11px] text-ink-soft">
                    Revoke for every connected client?
                  </span>
                  <button
                    type="submit"
                    disabled={revokePending}
                    className="rounded-md border border-stamp bg-stamp px-2.5 py-1 font-mono text-[9.5px] tracking-wide text-white uppercase disabled:opacity-60"
                  >
                    {revokePending ? "revoking" : "revoke"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRevoke(false)}
                    className="rounded-md border border-rule px-2.5 py-1 font-mono text-[9.5px] tracking-wide text-ink-soft uppercase"
                  >
                    keep
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmRevoke(true)}
                  className="ml-auto rounded-md border border-rule px-2.5 py-1 font-mono text-[9.5px] tracking-wide text-ink-soft uppercase hover:border-stamp hover:text-stamp"
                >
                  revoke
                </button>
              )
            ) : null}
          </div>
        ) : (
          <form action={mintAction} className="mt-2.5">
            <button
              type="submit"
              disabled={mintPending || !row.isOwner}
              className="rounded-md border border-accent bg-accent px-3 py-1.5 font-mono text-[10px] tracking-wide text-white uppercase disabled:opacity-60"
            >
              {mintPending ? "minting" : "mint credential"}
            </button>
            {!row.isOwner ? (
              <span className="ml-2 text-[11px] text-ink-faint">
                Minting is the owner's pen.
              </span>
            ) : null}
          </form>
        )}

        {mintState.error ? (
          <p className="mt-2 text-[11.5px] text-stamp">{mintState.error}</p>
        ) : null}
        {revokeState.error ? (
          <p className="mt-2 text-[11.5px] text-stamp">{revokeState.error}</p>
        ) : null}
      </div>
    </div>
  );
}
