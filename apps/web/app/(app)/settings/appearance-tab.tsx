"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

/*
 * Settings → Appearance, master mockup v2 (setSTab 'appearance') — now the
 * ONLY appearance door (founder amendment, fix round: the top-bar Aa is
 * gone; one-door pattern, same law as integrations-once). All per-user,
 * stored locally. Semantic colours never move: gold/prism = Light acted,
 * red = your stamp, green = done — in every theme, font and size.
 */

const THEMES = [
  ["frost", "Frost"],
  ["ledger", "Ledger"],
  ["mono", "Mono"],
] as const;

const ACCENTS = [
  ["blue", "Blue"],
  ["green", "Register green"],
  ["cool", "Cool slate"],
  ["warm", "Warm clay"],
  ["violet", "Violet"],
  ["rose", "Rose"],
  ["amber", "Amber"],
] as const;

const LIGHTS = [
  ["prism", "Prism — living"],
  ["gold", "Gold"],
] as const;

const FONTS = [
  ["theme", "Theme"],
  ["serif", "Serif"],
  ["sans", "Sans"],
  ["round", "Round"],
] as const;

const SIZES = [
  ["compact", "A−"],
  ["default", "A"],
  ["large", "A+"],
] as const;

const VIEWS = [
  ["phone", "📱 Phone"],
  ["standard", "☰ Standard"],
] as const;

function persist(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private browsing — the choice simply does not persist */
  }
}

function Segment({
  items,
  value,
  onPick,
}: {
  items: readonly (readonly [string, string])[];
  value: string;
  onPick: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-0.5 rounded-md bg-paper-deep p-0.5">
      {items.map(([key, label]) => (
        <button
          key={key}
          type="button"
          onClick={() => onPick(key)}
          className={cn(
            "rounded px-2.5 py-1 font-mono text-[9.5px] font-semibold tracking-wide uppercase",
            value === key ? "bg-panel text-ink shadow-panel" : "text-ink-soft"
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function AppearanceTab() {
  const [theme, setTheme] = useState("frost");
  const [accent, setAccent] = useState("blue");
  const [light, setLight] = useState("prism");
  const [font, setFont] = useState("theme");
  const [size, setSize] = useState("default");
  const [view, setView] = useState("phone");

  useEffect(() => {
    const d = document.documentElement.dataset;
    setTheme(d.theme === "ledger" || d.theme === "mono" ? d.theme : "frost");
    if (ACCENTS.some(([k]) => k === d.accent)) setAccent(d.accent as string);
    setLight(d.lightac === "gold" ? "gold" : "prism");
    if (FONTS.some(([k]) => k === d.font)) setFont(d.font as string);
    if (SIZES.some(([k]) => k === d.size)) setSize(d.size as string);
    try {
      const v = localStorage.getItem("ui-convview");
      if (v === "standard") setView("standard");
    } catch {
      /* stays phone */
    }
  }, []);

  const rows: {
    label: string;
    items: readonly (readonly [string, string])[];
    value: string;
    apply: (v: string) => void;
  }[] = [
    {
      label: "Theme",
      items: THEMES,
      value: theme,
      apply: (v) => {
        setTheme(v);
        // Frost is the default: absence of the attribute IS Frost.
        if (v === "frost") delete document.documentElement.dataset.theme;
        else document.documentElement.dataset.theme = v;
        persist("ui-theme", v);
      },
    },
    {
      label: "Accent",
      items: ACCENTS,
      value: accent,
      apply: (v) => {
        setAccent(v);
        document.documentElement.dataset.accent = v;
        persist("ui-accent", v);
      },
    },
    {
      label: "Light",
      items: LIGHTS,
      value: light,
      apply: (v) => {
        setLight(v);
        document.documentElement.dataset.lightac = v;
        persist("ui-light", v);
      },
    },
    {
      label: "Font",
      items: FONTS,
      value: font,
      apply: (v) => {
        setFont(v);
        if (v === "theme") delete document.documentElement.dataset.font;
        else document.documentElement.dataset.font = v;
        persist("ui-font", v);
      },
    },
    {
      label: "Size",
      items: SIZES,
      value: size,
      apply: (v) => {
        setSize(v);
        if (v === "default") delete document.documentElement.dataset.size;
        else document.documentElement.dataset.size = v;
        persist("ui-size", v);
      },
    },
    {
      label: "Conversation view",
      items: VIEWS,
      value: view,
      apply: (v) => {
        setView(v);
        // Stamp the html element too, so an in-app navigation to
        // Conversations picks the default up without a refresh.
        if (v === "standard") document.documentElement.dataset.convview = "standard";
        else delete document.documentElement.dataset.convview;
        persist("ui-convview", v);
      },
    },
  ];

  return (
    <>
      <div className="glass rounded-xl px-4 py-2">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex flex-wrap items-center gap-3 border-b border-dashed border-paper-deep py-2.5 last:border-b-0"
          >
            <span className="w-40 shrink-0 font-mono text-[9.5px] font-semibold tracking-[.08em] text-ink-faint uppercase">
              {row.label}
            </span>
            <Segment items={row.items} value={row.value} onPick={row.apply} />
          </div>
        ))}
      </div>
      <p className="mt-3 font-mono text-[11px] text-ink-faint uppercase">
        All per-user · this is the only door — Conversations renders straight from these
        settings (decision 77) · semantic colours never move: gold = Light acted, red =
        your stamp, green = done.
      </p>
    </>
  );
}
