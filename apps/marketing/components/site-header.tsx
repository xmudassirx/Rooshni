import Link from "next/link";
import { DEMO_PATH } from "@/lib/links";

export function SiteHeader() {
  return (
    <header className="rule-top" style={{ borderTop: "3px solid var(--ink)" }}>
      <div
        className="container"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
          paddingBlock: "1.1rem",
          flexWrap: "wrap",
        }}
      >
        <Link
          href="/"
          style={{
            fontFamily: "var(--font-serif)",
            fontSize: "1.45rem",
            fontWeight: 600,
            textDecoration: "none",
            letterSpacing: "-0.01em",
          }}
        >
          Barakah
        </Link>
        <nav aria-label="Main">
          <ul
            style={{
              display: "flex",
              alignItems: "center",
              gap: "1.4rem",
              listStyle: "none",
              margin: 0,
              padding: 0,
              fontSize: "0.92rem",
              flexWrap: "wrap",
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
              <Link href={DEMO_PATH} className="btn btn-primary" style={{ padding: "0.5rem 1rem" }}>
                Request a demo
              </Link>
            </li>
          </ul>
        </nav>
      </div>
    </header>
  );
}
