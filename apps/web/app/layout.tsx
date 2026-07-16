import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Bitter, IBM_Plex_Mono, Public_Sans } from "next/font/google";

import "./globals.css";

const publicSans = Public_Sans({
  subsets: ["latin"],
  variable: "--font-public-sans",
});

const bitter = Bitter({
  subsets: ["latin"],
  weight: ["600", "700", "800", "900"],
  variable: "--font-bitter",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
});

export const metadata: Metadata = {
  title: "Rooshni",
  description:
    "An AI operating system for businesses — one database, many faces.",
};

// Applies saved appearance choices before first paint. Frost + blue accent +
// prism Light is the shipping default (decision 62): absence of data-theme IS
// Frost, absence of data-accent IS blue. The storage keys are deliberately
// generic: this script ships on the public holding page too, and the public
// surface carries no product name (Session 5 founder rule).
const themeBoot = `try{var d=document.documentElement,t=localStorage.getItem("ui-theme");if(t==="ledger")d.dataset.theme=t;else delete d.dataset.theme;var a=localStorage.getItem("ui-accent");if(a)d.dataset.accent=a;d.dataset.lightac=localStorage.getItem("ui-light")==="gold"?"gold":"prism"}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en-GB"
      data-lightac="prism"
      className={`${publicSans.variable} ${bitter.variable} ${plexMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
