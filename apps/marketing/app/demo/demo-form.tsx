"use client";

import { useState } from "react";

type Status = "idle" | "submitting" | "sent" | "error";

export function DemoForm() {
  const [status, setStatus] = useState<Status>("idle");
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "submitting") return;
    setStatus("submitting");
    setErrorDetail(null);

    const form = event.currentTarget;
    const data = new FormData(form);
    const body = {
      name: String(data.get("name") ?? ""),
      firm: String(data.get("firm") ?? ""),
      email: String(data.get("email") ?? ""),
      phone: String(data.get("phone") ?? ""),
      message: String(data.get("message") ?? ""),
      // Honeypot: humans never see or fill this field.
      website: String(data.get("website") ?? ""),
    };

    try {
      const response = await fetch("/api/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await response.json().catch(() => ({}))) as { detail?: string };
      if (!response.ok) {
        setErrorDetail(result.detail ?? "Something went wrong on our side.");
        setStatus("error");
        return;
      }
      setStatus("sent");
    } catch {
      setErrorDetail("The request did not reach us. Check your connection and try again.");
      setStatus("error");
    }
  }

  if (status === "sent") {
    return (
      <div
        role="status"
        style={{
          background: "var(--green-soft)",
          border: "1px solid var(--green)",
          borderRadius: "0.375rem",
          padding: "2rem",
          alignSelf: "start",
        }}
      >
        <h2 style={{ fontSize: "1.3rem" }}>Received.</h2>
        <p style={{ marginTop: "0.7rem", fontSize: "0.95rem" }}>
          Your request is in our pipeline and a human will reply by email, usually within one
          working day. No mailing list, no sequence, just the reply.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate={false} style={{ display: "grid", gap: "1.1rem", alignSelf: "start" }}>
      <div className="field">
        <label htmlFor="demo-name">Your name</label>
        <input id="demo-name" name="name" type="text" required maxLength={200} autoComplete="name" />
      </div>
      <div className="field">
        <label htmlFor="demo-firm">Firm name</label>
        <input id="demo-firm" name="firm" type="text" required maxLength={200} autoComplete="organization" />
      </div>
      <div className="field">
        <label htmlFor="demo-email">Work email</label>
        <input id="demo-email" name="email" type="email" required maxLength={320} autoComplete="email" />
      </div>
      <div className="field">
        <label htmlFor="demo-phone">
          Phone <span className="muted" style={{ fontWeight: 400 }}>(optional)</span>
        </label>
        <input id="demo-phone" name="phone" type="tel" maxLength={40} autoComplete="tel" />
      </div>
      <div className="field">
        <label htmlFor="demo-message">
          Anything you want the demo to cover{" "}
          <span className="muted" style={{ fontWeight: 400 }}>(optional)</span>
        </label>
        <textarea id="demo-message" name="message" rows={4} maxLength={2000} />
      </div>
      {/* Honeypot: hidden from people, tempting to bots. */}
      <div className="hp-field" aria-hidden="true">
        <label htmlFor="demo-website">Website</label>
        <input id="demo-website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>
      {status === "error" ? (
        <p
          role="alert"
          style={{
            background: "var(--red-soft)",
            border: "1px solid var(--red)",
            borderRadius: "0.25rem",
            padding: "0.8rem 1rem",
            fontSize: "0.9rem",
          }}
        >
          {errorDetail}
        </p>
      ) : null}
      <button type="submit" className="btn btn-primary" disabled={status === "submitting"} style={{ justifySelf: "start", cursor: "pointer" }}>
        {status === "submitting" ? "Sending…" : "Request a demo"}
      </button>
      <p className="muted" style={{ fontSize: "0.8rem" }}>
        What you send here is stored as an enquiry in our own Barakah system and used only to
        reply to you. See the privacy notice for the full, short story.
      </p>
    </form>
  );
}
