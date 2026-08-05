# Barakah design tokens — the extracted reference

Extracted from `docs/design/master-mockup-v2.html` (the design authority),
`apps/web/app/globals.css` (the live product token system) and
`apps/marketing/app/globals.css` (the marketing register). Values here are
the real ones — where the two sources disagree, the row says so with a
`JUDGMENT:` mark; nothing is resolved silently. Precedence on conflict:
AMENDMENTS-PASS3 > in-file amendments > mockup pixels (ui-system skill).

## Semantic colours — law in every theme (decision 61)

These four meanings never move, whatever the theme, accent, font or size.

| Token | Value | Tint / line | Why |
|---|---|---|---|
| `--gold` | `#b07c1f` | tint `#f7eeda` · line `#e5d2a4` | Gold = **Light acted** — drafts, proposals, costs, Light's chips and pins. Agency must read at a glance: a gold element was the machine's hand. |
| `--stamp` | `#c13b2a` | tint `#f9ece9` | Red = **the human stamp** — approval authority, a withheld Approve, overdue/SLA breach. Red is the weight of a human signature, nothing else. |
| `--ledger` | `#2e6b4f` | tint `#e7efe9` · line `#c7d8cd` | Green = **done/published** — sent, paid, active, received. Decision 66 swept green out of chrome; it is an outcome colour only. |
| `--amber` | `#c08a1e` | — | The provisional register — unconfirmed timers, ageing approvals nearing SLA. Warns without claiming Light's gold or the stamp's red. |

## Accent — chrome & kinds (decision 61)

ACCENT drives active states, primary buttons, table headers, focus rings,
data bars and kind chips. It follows the user's choice; meaning never rides
on it. Seven accents (AMENDMENTS-PASS3 law 5); **blue is the default**.

| Accent | `--accent` | `--accent-tint` |
|---|---|---|
| blue (default) | `#3e6fbf` | `#e8eff9` |
| green | `#2e6b4f` | `#e7efe9` |
| cool | `#3e5a78` | `#e9eff6` |
| warm | `#a65e2e` | `#f6ebe2` |
| violet | `#6c4fb8` | `#eee9f8` |
| rose | `#b04a6e` | `#f8e9ef` |
| amber | `#b07c1f` | `#f7eeda` |

Mono outranks the accent: `[data-theme="mono"]` forces `--accent:#141414`,
`--accent-tint:#efefef` — chrome is black in the white/black theme.

## Themes (decision 62)

Default = **Frost + blue accent + prism Light**. In the live CSS the absence
of `data-theme` IS Frost; each theme defines its complete variable set — a
partial set leaks another theme's tint (the frost cream-leak incident).

> **JUDGMENT:** the mockup and the live CSS invert the base set. The
> mockup's `:root` holds the Ledger (cream paper) palette with Frost as a
> `data-theme` override on `<body>`; the live CSS's `:root` holds Frost,
> with `[data-theme="ledger"]` as the override on `<html>`. Decision 62 and
> AMENDMENTS-PASS3 law 5 side with the live encoding (Frost default). Read
> the mockup's `:root` as the authority for **Ledger** values, not for the
> default theme. Recorded, not resolved here.

### Frost (default) — glass over a soft wash

| Token | Value | Why |
|---|---|---|
| `--paper` | `#f7f8fb` | Frost's own neutral — no cream leakage (decision 62). |
| `--panel` | `rgba(255,255,255,0.66)` | Panels are glass; `.glass` adds `backdrop-filter: blur(22px) saturate(1.3)`. |
| `--paper-deep` | `#eceff4` | Recessed wells (column bodies, segment tracks). |
| `--ink` / `--ink-soft` / `--ink-faint` | `#202b38` / `#5a6371` / `#8b94a1` | The three text weights: primary, secondary, metadata. |
| `--rule` | `#dee3eb` | Hairlines and borders. |
| `--sidebar` | `rgba(255,255,255,0.55)` | `.sidebar-glass` blurs at 26px, saturate 1.5. |
| `--sidebar-solid` / `--topbar-solid` | `#f2f3f8` / `#f4f5f9` | Session 23 opacity law: anything floating OVER content goes solid below 880px — translucency over text reads as defect. |
| `--panel-border` | `rgba(255,255,255,0.75)` | Glass edges are white light, not ink. |
| `--shadow-panel` | `0 8px 30px rgba(30,37,48,0.08)` | One soft lift; Frost panels float. |
| `--font-display` | Public Sans | Frost headlines are sans, tracking −.02em. |
| body background | 3 radial washes (`rgba(244,214,183,.55)`, `rgba(196,214,242,.6)`, `rgba(233,205,226,.5)`) over `linear-gradient(160deg,#f3f1f7,#edf1f4)`, fixed | The wash gives the glass something to refract. Frost-only. |

### Ledger — paper, ink and the register green

| Token | Value | Why |
|---|---|---|
| `--paper` | `#fbf9f3` | Cream ledger paper. |
| `--panel` | `#ffffff` | Solid panels — no glass in Ledger. |
| `--paper-deep` | `#f2eee2` | Deeper paper wells. |
| `--rule` | `#ddd6c4` | Warm hairlines. |
| `--sidebar` | `var(--ink)` (`#202b38`) | Dark chrome sidebar; text `#edeae0`, strong `#fbf9f3`. |
| `--topbar-solid` | `#ffffff` | Session 23 addition beyond the mockup (whose Ledger topbar is paper cream) — floating chrome goes solid. |
| `--shadow-panel` | `0 1px 2px rgba(32,43,56,.06), 0 4px 14px rgba(32,43,56,.05)` | The mockup's `--shadow`, verbatim. |
| `--font-display` | Bitter | Ledger headlines are the serif, weight 800, tracking −.01em. |

### Mono — white/black luxury (decision 62)

| Token | Value | Why |
|---|---|---|
| `--paper` / `--panel` | `#ffffff` | Luxurious whitespace; panels indistinguishable from page. |
| `--paper-deep` | `#f6f6f6` | The faintest well. |
| `--ink` / `--ink-soft` / `--ink-faint` | `#141414` / `#5b5b5b` / `#9c9c9c` | Near-black ink ladder. |
| `--rule` / `--panel-border` | `#eaeaea` / `#ededed` | Hairlines barely there. |
| `--accent` (forced) | `#141414` / tint `#efefef` | Chrome collapses to black — while gold, red and green never move. |
| `--shadow-panel` | `0 1px 2px rgba(0,0,0,.03), 0 8px 28px rgba(0,0,0,.05)` | Lift without weight. |

## Light's channel — gold | prism (decisions 61, 81)

Prism is the default, user-switchable to plain gold in Appearance. The
`.light-*` classes in `apps/web/app/globals.css` are the ONLY place prism
may appear — chrome takes the accent, done stays green, the stamp stays red.

| Element | Value |
|---|---|
| Prism gradient (solid elements: buttons, chips, avatars, pins) | `linear-gradient(115deg, #f0a93b, #e8563f 30%, #b44fd8 55%, #3f8cff 80%, #2e9e6b)`, `background-size: 220% 220%`, `animation: prismshift 6s ease infinite` |
| Prism wash (panels, mesh) | same stops at ~0.07–0.13 alpha, `120deg`, `background-size: 300% 300%`, `9s`; border `rgba(180,79,216,0.4)` (mesh `0.28`) |
| Prism text | gradient `background-clip: text`, `color: transparent` |
| Gold fallback | every `.light-*` class renders in `--gold`/`--gold-tint` when prism is off |
| `prismshift` | `0%,100% {background-position:0% 50%} 50% {background-position:100% 50%}` — the one signed looping animation in product chrome (see barakah-motion STANDARDS.md) |

## Faces — the type system

| Face | Role | Why |
|---|---|---|
| Public Sans (400–800) | Body and sans display (Frost default) | The working voice — plain, legible, unshowy. |
| Bitter (600–900) | Serif display (Ledger and Mono default; user-selectable) | The ledger-book headline voice. |
| IBM Plex Mono (400–600) | **The register face — never changes, any theme, any font choice** | Timestamps, section labels, chips, pre-flight facts, The Record's lines are technical truth; truth does not restyle. |
| Nunito (500–800) | The "Round" user font option only | An Appearance choice, never a default. |

`<html lang="en-GB">`; British English in every user-facing string.

## Type scale (mockup values)

| Step | Value | Use |
|---|---|---|
| Body | 15px / 1.5 | The base; the app never drops below 11.5px for readable prose. |
| Page h1 | 24px, display face, 800 (Frost: 700) | Page heads. Case/detail h1: 22px. |
| Display number | 30px, display 900 | Dashboard tiles (`.dnum`). |
| Card title | 14px / 700 | Names on cards and rows. |
| Small body | 12.5–13.5px | Card metadata, secondary prose. |
| Mono label | 9–11.5px, letterspacing .04–.18em, uppercase | The register: nav labels 9px/.18em, panel headers 10.5px/.14em, chips 10px/.04em, crumbs 11.5px/.04em. Smaller = wider tracking. |
| Size tokens | `compact` zoom .9 · `large` zoom 1.12 | Whole-app scaling, per user. |

## Radius ladder (mockup values)

| Step | Value | Use |
|---|---|---|
| Chip | 4–5px | Chips, badges, key-value tags. |
| Control | 7–9px | Buttons, inputs, small cards, toolbar buttons. |
| Card | 9–10px (Frost: 14px) | Board cards, queue items, notes. |
| Panel | 12px (Frost: 18px · Mono: 16px) | Panel boxes, case heads. Frost softens every step. |
| Modal | 14px (utility) → 28px (Ask Light) | The more conversational the surface, the rounder. |
| Pill | 16–26px (half of height) | Filter pills, ask bar, send pill, phone frame 26px. |

## Spacing steps (mockup values)

| Step | Use |
|---|---|
| 2 / 4 / 6px | Chip gaps, inline metadata gaps. |
| 8–12px | Intra-card padding (`11px 12px` is the standard card), grid gaps on boards (12px). |
| 14–18px | Panel padding (`12px 16px` headers, `14px 16px` bodies, `18px 20px` large). |
| 16px | The standard grid gap (`grid2`, rails). |
| 22px | Content padding; content max-width 1220px. Mobile: `16px 14px`. |

## Shadows

| Token | Value | Where |
|---|---|---|
| Ledger panel | `0 1px 2px rgba(32,43,56,.06), 0 4px 14px rgba(32,43,56,.05)` | Cards, panels. |
| Frost panel | `0 8px 30px rgba(30,37,48,.08)` | Glass panels. |
| Modal | `0 24px 80px rgba(32,43,56,.22), 0 2px 8px rgba(32,43,56,.06)` | Ask-class modals. |
| Popover | live rule: `.popover-surface` is **opaque `--paper` + `--shadow-panel`, never glass** (Session 23) | Dropdowns, calendars, pickers. |

## Structural surface laws carried by the tokens

- `.glass` = panel surface (solid in Ledger, blurred in Frost). **Modals are
  never glass**: one `.modal-scrim` (ink 42%, blur 3px) + one
  `.modal-surface` (opaque `--paper`) shared by every modal.
- One appearance door: Settings → Appearance (decision 64 removed the
  mockup's top-bar Aa control — mockup pixels overridden by decision).
- Components consume tokens only — never raw hex, never a colour that
  bypasses the vocabulary (ui-system skill).

## The marketing register (apps/marketing — Session 17)

The marketing site is **its own lighter system, NOT the product chrome**.
It may quote the product's colour taxonomy only when SHOWING the product;
the three meanings still hold and **gold is never chrome** there either.

| Token | Value | Why |
|---|---|---|
| `--ink` / `--paper` / `--paper-deep` | `#1a1712` / `#fcfbf8` / `#f3f1ea` | Warmer, print-like page — the argument reads like an essay. |
| `--rule` / `--muted` | `#e4e0d5` / `#6c6557` | Hairlines and secondary voice. |
| Quoted taxonomy | gold `#96731b`/`#f7f0dd` · red `#a63a2e`/`#f8e9e6` · green `#1e7a46`/`#e7f2ea` | Used ONLY inside product depictions (The Record fragment). |
| Headlines | serif (`--font-serif`), weight 500, `clamp(2.4rem, 6vw, 4rem)` | Marketing argues in the serif; product works in the sans. |
| Buttons | ink on paper, radius 0.25rem, 120ms colour transition | Restraint is the brand. |
| Measure | `--maxw: 68rem`, prose 44rem | Essay measure, not app density. |

> **JUDGMENT:** the marketing site's quoted taxonomy hexes (`#96731b`,
> `#a63a2e`, `#1e7a46`) deliberately differ from the product tokens
> (`#b07c1f`, `#c13b2a`, `#2e6b4f`) — its own header comment declares the
> lighter system. The divergence is in the repo as shipped; recorded here
> so no session "corrects" either side silently.

## THE BARAKAH TEST

Take a screenshot of the surface. Cover the copy. If you cannot read WHO
ACTED from colour alone — gold where Light moved, red where a human stamp
is owed or given, green where a thing is done, accent everywhere the user
merely navigates — the surface FAILS, whatever else is beautiful. Beauty
that obscures agency is a defect in this product, not a style.
