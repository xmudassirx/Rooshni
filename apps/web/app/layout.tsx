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

// Applies the saved theme before first paint so a Frost user never sees a
// flash of Ledger. Ledger is the shipping default. The storage key is
// deliberately generic: this script ships on the public holding page too,
// and the public surface carries no product name (Session 5 founder rule).
const themeBoot = `try{var t=localStorage.getItem("ui-theme");if(t==="frost")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en-GB"
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
