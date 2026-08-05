# Barakah motion standards — the frequency ladder, numbers and review protocol

Motion in this product is earned, not decorative. A regulated firm's
console is calm: the default verdict for animation on a high-frequency
surface is NO, and everything below exists to make the exceptions precise.
Sources: `docs/design/master-mockup-v2.html` (the existing motion
inventory), `apps/web/app/globals.css` and
`apps/marketing/app/globals.css` (the shipped rules).

## The frequency ladder — real surfaces

How often a user meets a surface decides whether it may move. Frequency
beats beauty every time.

| Tier | Real surfaces | Rule |
|---|---|---|
| **Hundreds-daily** | Approval Inbox cards · The Record rows · sidebar nav items · Conversations thread list · Enquiries board cards · anything keyboard-initiated (search, filters, shortcuts) | **Never animates.** State changes are instant. A 200ms entrance met 300 times is a minute of enforced waiting per day. |
| **Several-daily** | Contact rail open/close · Settings tab switch · appearance popover · panel open · mobile nav drawer · view toggles (phone/standard) | **Functional motion at the fast end only** — ≤150ms, and only where it explains a spatial change (a drawer sliding from where it lives). |
| **Once-per-event** | Marker arrival (a new gold pin landing on a timeline you are watching) · First Light (the onboarding pill's first appearance) · the stamp landing on approval · a refusal card appearing · a send-failure turning red | **May animate, subtly.** These are the moments where motion carries meaning: something irreversible or significant just happened. |

Promotion is one-way: a surface that grows in frequency loses its motion.
The review protocol below enforces this.

## The numbers

| Class | Duration | Notes |
|---|---|---|
| Micro-feedback | ~150ms | Hover tints, pressed states, toggles. The mockup's press is `transform .1s` to `scale(.98)`. |
| Entrances | 200–250ms | Once-per-event appearances. The shipped stamp landing is 250ms (`stampin`: scale 1.6→1 with the −5° rotate, opacity 0→1, ease-out). |
| Spatial | up to 300ms | Drawers, resizes — motion that explains where something went. The mockup's mobile sidebar slides at 200ms. |
| Ceiling | **UI motion under 300ms, always** | Anything longer is theatre. |

## The easing decision tree

- **Entering or exiting** → ease-out (start fast, land soft).
- **Moving while staying on-screen** → ease-in-out.
- **Constant motion** (progress, the signed prism shift) → linear or the
  declared gradient ease; never eased ends on a loop.
- **ease-in on UI: never.** An ease-in entrance makes the interface feel
  like it hesitates before obeying. There is no case for it in chrome.

## Named custom curves — declared once, as CSS variables

The built-in keywords are too weak for product chrome: `ease-out` decays
too gently to feel stamped, `ease-in-out` drags its ends. Use these named
curves, declared **once** in `apps/web/app/globals.css` when a motion
session first lands them (skills are method — this file does not add CSS):

| Variable | Value | Replaces | Character |
|---|---|---|---|
| `--motion-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | `ease-out` | Arrives decisively, settles without bounce — entrances and exits. |
| `--motion-through` | `cubic-bezier(0.65, 0, 0.35, 1)` | `ease-in-out` | Symmetric travel for on-screen moves — drawers, reorders. |
| `--motion-press` | `cubic-bezier(0.2, 0, 0.4, 1)` | `ease` | Sub-150ms micro-feedback; near-linear so the tap feels immediate. |

Never inline a bezier at a use site; a curve used twice with two values is
two languages.

## Properties

- **Animate `transform` and `opacity` only.** Both composite off the main
  thread; nothing else is worth a frame budget.
- Colour and border-colour crossfades are permitted **only** as
  micro-feedback (≤150ms hover/press tints — paint, not layout), matching
  the mockup's `.12–.15s` hovers.
- **No layout properties, ever**: no animated `width`, `height`,
  `top/left`, `margin`, `padding`, `font-size`. A drawer moves by
  transform, not by animating its width.

## Reduced motion — a checkable requirement

`@media (prefers-reduced-motion: reduce)` must neutralise every animation
and transition. Both shipped stylesheets already carry the global kill
(`* { transition: none !important; animation: none !important; }` in
`apps/web/app/globals.css`; the equivalent in
`apps/marketing/app/globals.css`). The requirement on every motion change:
**state the reduced-motion behaviour in the spec, and verify the global
kill still covers the new rule** (inline styles and JS-driven animation
escape it — those must check the media query themselves). A motion spec
without a reduced-motion line is incomplete and is returned.

## Looping and ambient motion

**None, ever, in product chrome.** A regulated firm's console is calm; a
surface that moves while the user thinks is stealing attention from work.

- **Shimmer exists only as loading skeletons** — and stops the instant
  content arrives. The same class covers active-process indicators (the
  mockup's mic-listening pulse runs only while recording runs, and stops
  with it): motion tied to a real running process, dead the moment the
  process ends.
- **The one signed exception:** the prism gradient shift (`prismshift`,
  6s/9s) on Light's channel — decisions 61/62 make "prism — living"
  Light's identity, carried entirely by the `.light-*` token classes and
  switchable to static gold by the user. It is a signed law, not a
  precedent: nothing else loops, and nothing new may cite prism as cover.
- Marketing pages get no ambient motion either; the argument is made in
  words, and its buttons keep their 120ms colour transitions.

## REVIEW protocol

Every motion change is reviewed as **a single markdown table** — one row
per issue, no prose findings outside it:

| Before | After | Why |
|---|---|---|
| (what the surface does now, with its numbers) | (the exact proposed spec: duration, curve variable, properties, reduced-motion behaviour) | (the ladder tier + the rule that decides it) |

Two hard rules on review:

1. **Approval of ANY animation on a high-frequency surface must name the
   once-per-event moment that earns it** — in the Why cell, explicitly. "It
   feels nicer" names no moment and is a rejection. If no such moment
   exists, the row's After is "no motion".
2. A spec missing any of duration, curve, properties or reduced-motion
   behaviour is returned unreviewed — incomplete specs are not almost-done,
   they are unwritten.

## The shipped motion inventory (for calibration)

What already exists, so reviews compare against reality:

| Motion | Values | Tier |
|---|---|---|
| Stamp landing (`stampin`) | 250ms ease-out, rotate(−5°) scale 1.6→1, opacity 0→1 | Once-per-event — the compliant model. |
| Button press | `transform .1s`, scale(.98) | Micro-feedback. |
| Card hover | `transform .12s, border-color .12s`, translateY(−1px) | Micro-feedback (board cards — watch the frequency argument if boards become hundreds-daily working surfaces). |
| Nav/sidebar hovers | background `.12–.15s` | Micro-feedback tints. |
| Mobile sidebar | `left .2s` slide | Spatial (a transform-based rewrite is the compliant form). |
| Toast | `transform .25s` rise | Once-per-event feedback. |
| Prism shift | 6s (solids) / 9s (washes), infinite | The signed exception. |
| Mic pulse (`micpulse`) | 1.1s ease-in-out loop while listening | Active-process indicator — stops with the process. |
