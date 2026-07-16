"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Image as ImageIcon, Mic, Paperclip } from "lucide-react";

/*
 * The Ask Light MODAL (master mockup v2, openAsk/askSend): the front door
 * from anywhere in the shell. Rules from the mockup's script, kept exactly:
 * the textarea autofocuses on open, and the draft PERSISTS across close —
 * closing never clears it; only a prefill replaces it. Light's chat wiring
 * is a later session, so send answers honestly in the response slot and
 * records nothing.
 */

const AskLightContext = createContext<{ openAsk: (prefill?: string) => void }>({
  openAsk: () => {},
});

export function useAskLight() {
  return useContext(AskLightContext);
}

export function AskLightProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [response, setResponse] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const openAsk = useCallback((prefill?: string) => {
    // v2 openAsk(): a prefill replaces the draft; otherwise it persists.
    if (prefill !== undefined) setDraft(prefill);
    setOpen(true);
  }, []);

  useEffect(() => {
    if (open) taRef.current?.focus();
  }, [open]);

  function say(text: string) {
    setNotice(text);
    window.setTimeout(() => setNotice(null), 3600);
  }

  function send() {
    if (!draft.trim()) {
      say("Ask, instruct, or correct — the box is empty.");
      return;
    }
    setResponse(
      "Light's chat wiring is a later session — nothing was sent and nothing was recorded. When it lands, this thread answers from memory + The Record within your grants, and every action it takes passes the same gates as everywhere else."
    );
  }

  return (
    <AskLightContext.Provider value={{ openAsk }}>
      {children}
      {open ? (
        <>
          <button
            type="button"
            aria-label="Close"
            className="fixed inset-0 z-90 bg-ink/40 backdrop-blur-xs"
            onClick={() => setOpen(false)}
          />
          <div
            role="dialog"
            aria-label="Ask Light"
            className="glass fixed top-1/2 left-1/2 z-91 w-[min(620px,94vw)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[28px] shadow-[0_24px_80px_rgba(32,43,56,.22)]"
          >
            <div className="flex items-center gap-2 px-6 pt-4 font-mono text-[9.5px] font-bold tracking-[.16em] text-ink-faint uppercase">
              <span className="light-spark text-[13px]">✦</span>
              Ask Light anything · questions, instructions, corrections — all on The Record
            </div>
            <textarea
              ref={taRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Message Light…"
              className="min-h-38 w-full resize-none bg-transparent px-6 py-3.5 text-[15.5px] leading-relaxed text-ink outline-none placeholder:text-ink-faint"
            />
            <div className="flex items-center gap-1.5 border-t border-rule px-4.5 py-3.5">
              <button
                type="button"
                title="Attach a file"
                aria-label="Attach a file"
                className="flex size-10.5 items-center justify-center rounded-xl text-ink hover:bg-paper-deep"
                onClick={() =>
                  say("Attachments ride the files table — Light reads what you give it. Wiring arrives with the chat session.")
                }
              >
                <Paperclip className="size-5" />
              </button>
              <button
                type="button"
                title="Add an image"
                aria-label="Add an image"
                className="flex size-10.5 items-center justify-center rounded-xl text-ink hover:bg-paper-deep"
                onClick={() =>
                  say("Light reads images natively — screenshots, letters, documents. Wiring arrives with the chat session.")
                }
              >
                <ImageIcon className="size-5" />
              </button>
              <button
                type="button"
                title="Speak instead of typing"
                aria-label="Speak instead of typing"
                className="flex size-10.5 items-center justify-center rounded-xl text-ink hover:bg-paper-deep"
                onClick={() =>
                  say("Voice input arrives with Light's chat session — nothing is listening yet.")
                }
              >
                <Mic className="size-5" />
              </button>
              <button
                type="button"
                title="Send to Light"
                aria-label="Send to Light"
                className="light-btn ml-auto flex h-13 w-22 items-center justify-center rounded-[26px] text-lg shadow-[0_10px_26px_rgba(63,140,255,.35)]"
                onClick={send}
              >
                ↑
              </button>
            </div>
            {notice ? (
              <p className="px-6 pb-3 font-mono text-[10px] tracking-[.05em] text-amber uppercase">
                {notice}
              </p>
            ) : null}
            {response ? (
              <div className="light-panel mx-4.5 mb-4.5 rounded-xl px-4 py-3 text-[13px] leading-relaxed">
                <div className="light-head mb-1.5 font-mono text-[9.5px] font-bold tracking-[.12em] uppercase">
                  ✦ Light
                </div>
                {response}
                <div className="mt-2">
                  <button
                    type="button"
                    className="glass rounded-md px-2.5 py-1 font-mono text-[10px] font-semibold tracking-wide uppercase"
                    onClick={() => setResponse(null)}
                  >
                    Close
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </AskLightContext.Provider>
  );
}
