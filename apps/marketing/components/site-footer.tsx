import Link from "next/link";
import { DEMO_PATH, SIGNUP_URL } from "@/lib/links";

export function SiteFooter() {
  return (
    <footer className="rule-top" style={{ marginTop: "4rem" }}>
      <div
        className="container"
        style={{
          paddingBlock: "2.5rem",
          display: "flex",
          flexWrap: "wrap",
          gap: "2rem 4rem",
          justifyContent: "space-between",
        }}
      >
        <div style={{ maxWidth: "22rem" }}>
          <p style={{ fontFamily: "var(--font-serif)", fontSize: "1.2rem", fontWeight: 600 }}>
            Barakah
          </p>
          <p className="muted" style={{ fontSize: "0.88rem", marginTop: "0.5rem" }}>
            An AI operating system for UK immigration firms. Light drafts, you approve, The
            Record remembers.
          </p>
        </div>
        <nav aria-label="Footer">
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "grid",
              gap: "0.55rem",
              fontSize: "0.9rem",
            }}
          >
            <li>
              <Link href="/product">Product</Link>
            </li>
            <li>
              <Link href="/pricing">Pricing</Link>
            </li>
            <li>
              <Link href="/founder-note">Founder note</Link>
            </li>
            <li>
              <Link href={DEMO_PATH}>Request a demo</Link>
            </li>
            <li>
              <a href={SIGNUP_URL}>Sign up</a>
            </li>
          </ul>
        </nav>
        <nav aria-label="Legal">
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "grid",
              gap: "0.55rem",
              fontSize: "0.9rem",
            }}
          >
            <li>
              <Link href="/privacy">Privacy</Link>
            </li>
            <li>
              <Link href="/terms">Terms</Link>
            </li>
          </ul>
        </nav>
      </div>
      <div className="rule-top">
        <div className="container" style={{ paddingBlock: "1.2rem" }}>
          <p className="muted" style={{ fontSize: "0.8rem" }}>
            BarakahX. Built in the United Kingdom for regulated immigration practices.
          </p>
        </div>
      </div>
    </footer>
  );
}
