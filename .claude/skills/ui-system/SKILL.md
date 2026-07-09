---
name: ui-system
description: Use when building any UI in apps/web — the theme/token architecture, Ledger and Frost, the semantic colour invariants, shadcn conventions, and the signed design amendments in force. Keep current as the UI grows.
---

# UI system (as implemented after Sessions 4–5)

Design authority: `docs/mockup-pass1-shell-pipeline-case.html` plus the signed amendments below. Structure deviating from either is Lane C.

## Tokens and themes

All theming lives in `apps/web/app/globals.css`:

- **CSS custom properties on `:root`** define the palette — paper/ink neutrals, `--ledger` (register green), `--stamp` (red), `--gold`, their `-tint` pairs, rules/borders, sidebar surfaces, `--font-display`.
- **`[data-theme="frost"]` overrides** the same variables. There are exactly two themes: **Ledger** (the shipping default — paper, ink, Bitter display face, solid panels) and **Frost** (glass: translucent panels, backdrop blur, gradient background, Public Sans display face). Absence of the attribute IS Ledger; only `"frost"` is ever written.
- **`@theme inline`** bridges every variable into Tailwind v4 utilities (`text-ink`, `bg-paper`, `text-ledger`, `bg-stamp`, `font-display`, `shadow-panel`…). Components consume tokens only — never raw hex, never a colour that bypasses the vocabulary.
- **`.glass`** is the shared surface class: solid panel in Ledger, blur in Frost. Sidebar adds `.sidebar-glass`.
- Theme switching: `ThemeControl` in `apps/web/components/shell/app-shell.tsx` sets `document.documentElement.dataset.theme` and persists to `localStorage["ui-theme"]`. A boot script in `apps/web/app/layout.tsx` applies it before first paint. The storage key is deliberately generic — the public surface carries no product name (Session 5 founder rule, decision 25).

Fonts (loaded in `app/layout.tsx` via `next/font`): Public Sans (body/sans), Bitter (Ledger display), IBM Plex Mono (the register face). `<html lang="en-GB">`; British English in every user-facing string.

## Semantic invariants — law in every theme

- **Gold = Light acted.** **Red (`--stamp`) = human stamp required/withheld.** **Green (`--ledger`) = done.**
- **The monospace register face never changes** — metadata lines, pre-flight facts, section labels are IBM Plex Mono in both themes.
- Never render an unearned tick (decision 19 caveat): checks the database has not run display as *pending*, never green — see the `NOT_YET_RUN` pattern in `apps/web/app/(app)/inbox/inbox-card.tsx`.
- A screen is done only when it holds in **both** themes (see `preview-verification`).

## shadcn conventions

- Config: `apps/web/components.json` — new-york style, RSC, CSS variables, lucide icons.
- Primitives live in `apps/web/components/ui/` (button, badge, dialog, tabs, textarea so far), restyled to the token vocabulary — e.g. the button's `approve` variant is the stamp act. Add new primitives the shadcn way, then re-cut them to tokens; no default-gray shadcn look ships.
- `cn()` helper in `apps/web/lib/utils.ts`. Shell chrome (sidebar with Run/Think/Trust sections, topbar, breadcrumb) is `apps/web/components/shell/app-shell.tsx`; page headers and placeholders are `apps/web/components/shell/page-head.tsx`.

## Data access pattern

Server components call `getAppContext()` (`apps/web/lib/server/context.ts`) — a user-scoped, cookie-based Supabase client under RLS, resolving the signed-in human's own actor (decision 24). Mutations go through server actions that call the pipeline helpers in `@rooshni/db` (`approvals.ts`) — never direct table writes on gated paths. The database enforces every rule regardless; the UI is a face, not a control.

## Signed design amendments in force

1. **Approval Inbox is stacked full-width cards** — no split pane. Implemented: `apps/web/app/(app)/inbox/page.tsx` + `inbox-card.tsx`.
2. **Inbox items open editable drafts, with manual attach and "hand back to Light"** — signed, not yet built. Current state: expandable read-only card with approve/reject (`decision-controls.tsx`); reject requires a reason and returns the draft to Light's queue (decision 17).
3. **Conversations reply toggle: "message client directly" vs "brief Light"** — signed, page is a placeholder (`apps/web/app/(app)/conversations/page.tsx`). Incoming mail lands in Conversations, never in the Approval Inbox.
4. **Contacts: simple/advanced toggle, separate contact detail page** — signed, page is a placeholder (`apps/web/app/(app)/contacts/page.tsx`).
5. **The ledger screen is labelled "The Record"** — UI label only; internal names (events, the ledger) unchanged. Implemented: nav in `app-shell.tsx`, `apps/web/app/(app)/record/page.tsx`.
6. **Settings is tabbed: General / Team & Access / Appearance / Integrations** — structure implemented (`apps/web/app/(app)/settings/page.tsx`); each tab's content arrives with its own feature session.

## The public surface rule (Session 5)

The holding page (`app/construction/`) and sign-in page carry no wordmark, no tagline, no product name in metadata — a quiet site under construction. The discreet sign-in link is the only way in. Middleware rewrites (never redirects) outsiders to it, so the URL never changes.
