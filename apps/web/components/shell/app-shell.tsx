"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BookMarked,
  ChevronRight,
  Columns3,
  CreditCard,
  Globe,
  LayoutDashboard,
  LayoutPanelTop,
  LogOut,
  Mail,
  Megaphone,
  Menu,
  MessageSquareDot,
  PenLine,
  PoundSterling,
  ScrollText,
  Settings,
  Share2,
  SquareCheck,
  Stamp,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";

import { AskLightProvider, useAskLight } from "@/components/shell/ask-light";
import { cn } from "@/lib/utils";

function AskBar() {
  const { openAsk } = useAskLight();
  return (
    <button
      type="button"
      onClick={() => openAsk()}
      className="glass ml-auto flex min-w-36 cursor-pointer items-center gap-2 rounded-full px-3.5 py-1.5 text-[13px] text-ink-faint max-[880px]:min-w-0 max-[880px]:flex-1"
    >
      <span className="light-spark text-[14px] leading-none">✦</span>
      Ask Light anything…
    </button>
  );
}

interface NavChild {
  href: string;
  label: string;
}

interface NavItem {
  href: string;
  label: string;
  icon?: LucideIcon;
  /** Light's nav entry renders the spark glyph on Light's own channel. */
  spark?: boolean;
  badge?: number;
  /** Red badge = stamps awaiting; everything else takes the accent. */
  badgeStamp?: boolean;
  children?: NavChild[];
  /** SIGNED EXCEPTION surfaces render present-but-disabled, never clickable. */
  phase3?: boolean;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

function navSections(
  inboxCount: number,
  taskCount: number,
  showFeedback: boolean
): NavSection[] {
  return [
    {
      label: "Run",
      items: [
        { href: "/light", label: "Light", spark: true },
        { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
        {
          href: "/inbox",
          label: "Approval Inbox",
          icon: Stamp,
          badge: inboxCount,
          badgeStamp: true,
        },
        { href: "/tasks", label: "Tasks", icon: SquareCheck, badge: taskCount },
        { href: "/conversations", label: "Conversations", icon: Mail },
        {
          href: "/website",
          label: "Website",
          icon: Globe,
          children: [
            { href: "/website", label: "Pages" },
            { href: "/website/templates", label: "Templates" },
            { href: "/website/analytics", label: "Analytics" },
            { href: "/website/settings", label: "Settings" },
          ],
        },
        { href: "/campaigns", label: "Campaigns", icon: Megaphone },
        {
          href: "/social",
          label: "Social",
          icon: Share2,
          children: [
            { href: "/social", label: "Home" },
            { href: "/social/calendar", label: "Calendar" },
            { href: "/social/posts", label: "Posts" },
            { href: "/social/studio", label: "Studio" },
            { href: "/social/analytics", label: "Analytics" },
          ],
        },
        { href: "/enquiries", label: "Enquiries", icon: Columns3 },
        { href: "/automation", label: "Automation", icon: Workflow },
        { href: "/contacts", label: "Contacts", icon: Users },
        // JUDGMENT: Finance is a SIGNED EXCEPTION (Phase 3) screen — the
        // mockup's sidebar carries it, so it renders present-but-disabled
        // rather than as live nav to an unbuilt surface (Session 8, Lane B).
        { href: "/finance", label: "Finance", icon: PoundSterling, phase3: true },
      ],
    },
    {
      label: "Think",
      items: [
        { href: "/notes", label: "Notes", icon: PenLine },
        { href: "/memory", label: "Light's Memory", icon: BookMarked },
      ],
    },
    {
      label: "Trust",
      items: [
        // Founder amendment: the ledger screen is labelled "The Record"
        // (internal names — events, the append-only ledger — unchanged).
        { href: "/record", label: "The Record", icon: ScrollText },
        ...(showFeedback
          ? [{ href: "/feedback", label: "Feedback", icon: MessageSquareDot }]
          : []),
        // JUDGMENT: Client portal is a SIGNED EXCEPTION (Phase 3) screen —
        // present-but-disabled, same rule as Finance (Session 8, Lane B).
        {
          href: "/portal",
          label: "Client portal",
          icon: LayoutPanelTop,
          phase3: true,
        },
        { href: "/billing", label: "Billing & usage", icon: CreditCard },
        { href: "/settings", label: "Settings", icon: Settings },
      ],
    },
  ];
}

const crumbLabels: Record<string, string> = {
  "/light": "Light",
  "/dashboard": "Dashboard",
  "/inbox": "Approval Inbox",
  "/tasks": "Tasks",
  "/conversations": "Conversations",
  "/website/templates": "Website / Templates",
  "/website/analytics": "Website / Analytics",
  "/website/settings": "Website / Settings",
  "/website": "Website / Pages",
  "/campaigns": "Campaigns",
  "/social/calendar": "Social / Calendar",
  "/social/posts": "Social / Posts",
  "/social/studio": "Social / Studio",
  "/social/analytics": "Social / Analytics",
  "/social": "Social",
  "/enquiries": "Enquiries",
  "/automation": "Automation",
  "/contacts": "Contacts",
  "/notes": "Notes",
  "/memory": "Light's Memory",
  "/record": "The Record",
  "/feedback": "Feedback",
  "/billing": "Billing & usage",
  "/settings": "Settings",
};

function NavEntry({
  item,
  pathname,
  onNavigate,
}: {
  item: NavItem;
  pathname: string;
  onNavigate: () => void;
}) {
  const groupActive = pathname.startsWith(item.href);
  const [expanded, setExpanded] = useState(groupActive);
  useEffect(() => {
    if (groupActive) setExpanded(true);
  }, [groupActive]);

  if (item.phase3) {
    return (
      <div
        className="mb-px flex w-full cursor-not-allowed items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px] font-medium text-sidebar-fg/40"
        title="Phase 3 — a later session"
        aria-disabled
      >
        {item.icon ? <item.icon className="size-4 opacity-60" /> : null}
        {item.label}
        <span className="ml-auto rounded border border-dashed border-sidebar-fg/30 px-1.5 py-px font-mono text-[8.5px] tracking-[.1em] text-sidebar-fg/50 uppercase">
          Phase 3
        </span>
      </div>
    );
  }

  const childActive = (child: NavChild) =>
    child.href === item.href
      ? pathname === child.href ||
        (pathname.startsWith(`${child.href}/`) &&
          !item.children?.some(
            (c) => c.href !== item.href && pathname.startsWith(c.href)
          ))
      : pathname.startsWith(child.href);

  return (
    <>
      <Link
        href={item.href}
        onClick={() => {
          onNavigate();
          if (item.children) setExpanded(true);
        }}
        className={cn(
          "mb-px flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px] font-medium transition-colors",
          groupActive && !item.children
            ? "bg-accent font-semibold text-white"
            : groupActive
              ? "font-semibold text-sidebar-fg-strong"
              : "text-sidebar-fg/80 hover:bg-sidebar-fg-strong/5"
        )}
      >
        {item.spark ? (
          <span className="light-spark w-4 text-center text-[14px] leading-none">✦</span>
        ) : item.icon ? (
          <item.icon className="size-4 opacity-90" />
        ) : null}
        {item.label}
        {item.badge ? (
          <span
            className={cn(
              "ml-auto rounded-full px-1.5 py-px font-mono text-[10.5px] font-semibold text-white",
              item.badgeStamp ? "bg-stamp" : "bg-accent"
            )}
          >
            {item.badge}
          </span>
        ) : null}
        {item.children ? (
          <ChevronRight
            className={cn(
              "ml-auto size-3.5 opacity-60 transition-transform",
              expanded && "rotate-90"
            )}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
          />
        ) : null}
      </Link>
      {item.children && expanded ? (
        <div className="mt-0.5 mb-1 ml-4.5 border-l border-sidebar-fg/20 pl-2.5">
          {item.children.map((child) => (
            <Link
              key={child.href}
              href={child.href}
              onClick={onNavigate}
              className={cn(
                "mb-px flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[12.5px]",
                childActive(child)
                  ? "bg-sidebar-fg-strong/10 font-semibold text-sidebar-fg-strong"
                  : "text-sidebar-fg/70 hover:bg-sidebar-fg-strong/5"
              )}
            >
              {child.label}
            </Link>
          ))}
        </div>
      ) : null}
    </>
  );
}

export function AppShell({
  businessName,
  userName,
  userRole,
  inboxCount,
  taskCount,
  showFeedback,
  children,
}: {
  businessName: string;
  userName: string;
  userRole: string;
  inboxCount: number;
  taskCount: number;
  showFeedback: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sections = navSections(inboxCount, taskCount, showFeedback);
  const crumb =
    Object.entries(crumbLabels).find(([href]) => pathname.startsWith(href))?.[1] ??
    "Enquiries";

  return (
    <AskLightProvider>
    <div className="flex min-h-screen">
      <aside
        className={cn(
          "sidebar-glass fixed top-0 z-50 flex h-screen w-[232px] shrink-0 flex-col bg-sidebar text-sidebar-fg transition-[left] max-[880px]:-left-60 min-[881px]:sticky min-[881px]:left-0",
          sidebarOpen && "max-[880px]:left-0"
        )}
      >
        <div className="border-b border-sidebar-fg/15 px-4.5 pt-5 pb-3.5">
          <div className="font-display text-[17px] font-black text-sidebar-fg-strong">
            Rooshni
          </div>
          <div className="mt-0.5 font-mono text-[9.5px] tracking-[.16em] text-sidebar-fg/50 uppercase">
            One database · many faces
          </div>
        </div>
        <div className="mx-3 mt-3.5 mb-1.5">
          <div className="flex w-full items-center gap-2 rounded-lg border border-sidebar-fg/20 bg-sidebar-fg-strong/5 px-2.5 py-2 text-sidebar-fg-strong">
            <span className="size-2 shrink-0 rounded-xs bg-accent shadow-[0_0_0_1px_rgba(251,249,243,.4)]" />
            <span className="text-[13.5px] font-semibold">{businessName}</span>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 py-2.5">
          {sections.map((section) => (
            <div key={section.label}>
              <div className="px-2 pt-3 pb-1.5 font-mono text-[9px] tracking-[.18em] text-sidebar-fg/40 uppercase">
                {section.label}
              </div>
              {section.items.map((item) => (
                <NavEntry
                  key={item.href}
                  item={item}
                  pathname={pathname}
                  onNavigate={() => setSidebarOpen(false)}
                />
              ))}
            </div>
          ))}
        </nav>
        <div className="flex items-center gap-2.5 border-t border-sidebar-fg/15 px-4.5 py-3.5">
          {/* JUDGMENT: the mockup paints this avatar gold, but decision 61
              reserves prism|gold for Light's channel only — a human avatar
              takes the accent (AMENDMENTS-PASS3 outranks mockup pixels). */}
          <div className="flex size-7.5 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-bold text-white">
            {userName.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="truncate text-[12.5px] font-semibold text-sidebar-fg-strong">
              {userName}
            </div>
            <div className="font-mono text-[9.5px] tracking-wide text-sidebar-fg/50 uppercase">
              {userRole} · Account
            </div>
          </div>
          <form action="/auth/signout" method="post" className="ml-auto">
            <button
              type="submit"
              aria-label="Sign out"
              title="Sign out"
              className="rounded-md p-1.5 text-sidebar-fg/60 transition-colors hover:bg-sidebar-fg-strong/10 hover:text-sidebar-fg-strong"
            >
              <LogOut className="size-4" />
            </button>
          </form>
        </div>
      </aside>

      {sidebarOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-49 bg-ink/50 min-[881px]:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="glass sticky top-0 z-30 flex items-center gap-3 rounded-none border-x-0 border-t-0 px-5 py-2.5">
          <button
            type="button"
            className="hidden max-[880px]:block"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open navigation"
          >
            <Menu className="size-5" />
          </button>
          <span className="font-mono text-[11.5px] tracking-wide text-ink-faint">
            <b className="font-semibold text-ink">{businessName}</b> / {crumb}
          </span>
          {/* v2 openAsk(): the ask bar opens the MODAL — it never navigates.
              Founder amendment (fix round): the Aa control is gone; Settings →
              Appearance is the only appearance door. */}
          <AskBar />
        </header>
        <main className="w-full max-w-[1220px] p-5 max-[880px]:p-3.5">{children}</main>
      </div>
    </div>
    </AskLightProvider>
  );
}
