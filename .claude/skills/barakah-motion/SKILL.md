---
name: barakah-motion
description: Use when proposing, writing or reviewing ANY animation, transition or moving element on any Barakah surface — including deciding that something should NOT move, which is the usual outcome. Invoke it before adding a transition property, an @keyframes rule, or a JS-driven animation anywhere in apps/web or apps/marketing. Do NOT use for static colour, typography, spacing or layout questions (that is barakah-design-language).
---

# Barakah motion

Motion is the most expensive design material this product has: it spends
the user's attention on every appearance, forever. The default verdict for
animation on a high-frequency surface is **NO** — this skill exists to
make the refusals fast and the rare exceptions precise.

## SETUP — do these, in order, before any motion work

1. **MUST read `STANDARDS.md`** (this folder) in full — the frequency
   ladder with its real surfaces, the numbers, the easing decision tree,
   the named curves, the review protocol. Do not work from memory of it.
2. **MUST read at least one real file of the surface in focus**: for
   product work, `apps/web/app/globals.css` (the reduced-motion kill, the
   prism keyframes) plus the component being touched; for marketing work,
   `apps/marketing/app/globals.css` plus the page file. Know what already
   moves before you add movement.
3. **MUST determine the register and state it** in your first response:
   - **PRODUCT chrome** (`apps/web`) — design serves the work. The full
     ladder binds; hundreds-daily surfaces never animate; no looping or
     ambient motion ever (prism is the one signed exception, carried by
     tokens); every spec names its reduced-motion behaviour.
   - **MARKETING** (`apps/marketing`) — design is the argument, but calm
     is still the brand: no ambient motion, the same numbers and easing
     tree, the same reduced-motion requirement. Marketing earns no
     exemption from restraint; it argues in words.
4. **MUST place the surface on the frequency ladder** (STANDARDS.md table)
   and say which tier it is in — the tier decides the verdict before taste
   gets a vote.

## INSTRUCTIONS — the constraints

- **The default verdict for animation on a high-frequency surface is NO.**
  You start from refusal and require the surface to earn motion, not the
  reverse.
- **Quote STANDARDS.md, never invent a value.** Durations, curves and
  property choices come from its tables. The companion file is
  authoritative — where it and your instinct disagree, the file wins.
- **Every motion spec is complete or it is unwritten.** A spec states:
  duration, named curve variable, animated properties (transform/opacity
  only), and reduced-motion behaviour. Missing any one → not a spec.
- **Reviews are a single markdown table** `| Before | After | Why |`, one
  row per issue — the REVIEW protocol in STANDARDS.md, including its rule
  that any high-frequency animation approval must name the once-per-event
  moment that earns it.
- **Never add a loop.** Shimmer is loading-skeletons only; the prism shift
  is a signed law, not a precedent.
- **If a motion request conflicts with a signed decision or the mockup**,
  record a `JUDGMENT:` mark and apply the judgment lanes — never resolve
  silently.

## ROUTING

| Need | Go to |
|---|---|
| Tier, duration, curve, property or review-format rules | `STANDARDS.md` |
| Colour/typography/spacing of the same surface | `barakah-design-language` skill |
| Theme-engine mechanics · handover of built UI | `ui-system` · `preview-verification` skills |

## WORKED EXAMPLES

**1. "Should the sidebar nav animate when I switch sections?"**
Correct output: "**No.** The sidebar nav is a hundreds-daily surface
(STANDARDS.md ladder, tier 1) and section switching is often
keyboard-initiated — tier 1 never animates. The active state changes
instantly. The existing ≤150ms hover tint is micro-feedback and stays;
nothing new moves. Reduced-motion: nothing to declare, nothing moves."

**2. "Make the marker arrival feel alive."**
Correct output is a complete, compliant spec: "Marker arrival is
once-per-event (ladder tier 3) — it may animate, subtly. Spec: the gold
pin enters at **220ms** on **`var(--motion-out)`**
(`cubic-bezier(0.16, 1, 0.3, 1)`), animating **transform**
(`translateY(4px) scale(0.9)` → none) and **opacity** (0 → 1). No layout
properties; the timeline row reserves its space so nothing reflows.
**Reduced-motion:** the pin appears instantly at its final state — the
global kill covers the CSS rule; no JS animation involved. Nothing loops:
after arrival the pin is static gold (or the prism token if the user has
prism on — that living shift is the token's, not this spec's)."

**3. Review — a proposed ease-in entrance on the Approval Inbox cards.**
Correct output is the protocol table, and only the table:

| Before | After | Why |
|---|---|---|
| Cards render instantly on inbox load | Proposed: 300ms ease-in fade + slide per card — **rejected; no motion** | Inbox cards are hundreds-daily (ladder tier 1: never animates), and no once-per-event moment is named to earn an exception. Separately, ease-in is never used on UI (easing tree: entrances are ease-out) and 300ms is the ceiling, not a target. The stamp landing on approval (250ms, `stampin`) remains the inbox's one earned motion. |

**4. "Add a subtle looping glow to the Ask Light bar so people notice it."**
Correct output refuses with the anchor: "No — no looping or ambient motion
in product chrome, ever (STANDARDS.md): a regulated firm's console is
calm. The bar already carries Light's identity through the spark and, when
the user selects prism, the signed gradient shift — that token-level law
is the only loop and may not be extended. If discoverability is the real
problem, that is a design-language question (placement, contrast), not a
motion one."
