import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Bitter, IBM_Plex_Mono, Nunito, Public_Sans } from "next/font/google";

import "./globals.css";

const publicSans = Public_Sans({
  subsets: ["latin"],
  variable: "--font-public-sans",
});

const nunito = Nunito({
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
  variable: "--font-nunito",
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
const themeBoot = `try{var d=document.documentElement,g=function(k){return localStorage.getItem(k)},t=g("ui-theme");if(t==="ledger"||t==="mono")d.dataset.theme=t;else delete d.dataset.theme;var a=g("ui-accent");if(a)d.dataset.accent=a;d.dataset.lightac=g("ui-light")==="gold"?"gold":"prism";var f=g("ui-font");if(f&&f!=="theme")d.dataset.font=f;var s=g("ui-size");if(s&&s!=="default")d.dataset.size=s}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en-GB"
      data-lightac="prism"
      className={`${publicSans.variable} ${bitter.variable} ${plexMono.variable} ${nunito.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
