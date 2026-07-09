"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BookMarked,
  Columns3,
  LayoutDashboard,
  LogOut,
  Mail,
  Menu,
  PenLine,
  ScrollText,
  Settings,
  Sparkles,
  Stamp,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

function navSections(inboxCount: number): NavSection[] {
  return [
    {
      label: "Run",
      items: [
        { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
        { href: "/inbox", label: "Approval Inbox", icon: Stamp, badge: inboxCount },
        { href: "/conversations", label: "Conversations", icon: Mail },
        { href: "/enquiries", label: "Enquiries", icon: Columns3 },
        { href: "/automation", label: "Automation", icon: Workflow },
        { href: "/contacts", label: "Contacts", icon: Users },
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
        { href: "/settings", label: "Settings", icon: Settings },
      ],
    },
  ];
}

const crumbLabels: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/inbox": "Approval Inbox",
  "/conversations": "Conversations",
  "/enquiries": "Enquiries",
  "/automation": "Automation",
  "/contacts": "Contacts",
  "/notes": "Notes",
  "/memory": "Light's Memory",
  "/record": "The Record",
  "/settings": "Settings",
};

function ThemeControl() {
  const [theme, setTheme] = useState<"ledger" | "frost">("ledger");
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "frost" ? "frost" : "ledger");
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);

  function apply(next: "ledger" | "frost") {
    setTheme(next);
    if (next === "frost") {
      document.documentElement.dataset.theme = "frost";
    } else {
      delete document.documentElement.dataset.theme;
    }
    try {
      localStorage.setItem("ui-theme", next);
    } catch {
      /* private browsing — the choice simply does not persist */
    }
  }

  return (
    <div className="relative" ref={popRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="glass rounded-lg px-3 py-1.5 text-[13px] font-semibold text-ink hover:border-ledger"
        aria-label="Appearance"
      >
        Aa
      </button>
      {open && (
        <div className="glass absolute top-[calc(100%+8px)] right-0 z-60 w-64 rounded-xl p-3">
          <div className="flex items-center gap-2.5 px-0.5 py-1.5">
            <span className="w-13 shrink-0 font-mono text-[9.5px] font-semibold tracking-[.14em] text-ink-faint uppercase">
              Theme
            </span>
            <div className="flex flex-wrap rounded-lg border border-rule bg-paper-deep p-0.5">
              {(["ledger", "frost"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => apply(t)}
                  className={cn(
                    "rounded-md px-2.5 py-1 font-mono text-[10.5px] font-semibold tracking-wide uppercase",
                    theme === t ? "bg-ink text-paper" : "text-ink-soft"
                  )}
                >
                  {t === "ledger" ? "Ledger" : "Frost"}
                </button>
              ))}
            </div>
          </div>
          <p className="mt-2 border-t border-dashed border-rule pt-2.5 text-[11px] leading-snug text-ink-soft">
            Gold always means Light acted; red always means your stamp; green
            always means done — in every theme.
          </p>
        </div>
      )}
    </div>
  );
}

export function AppShell({
  businessName,
  userName,
  userRole,
  inboxCount,
  children,
}: {
  businessName: string;
  userName: string;
  userRole: string;
  inboxCount: number;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sections = navSections(inboxCount);
  const crumb =
    Object.entries(crumbLabels).find(([href]) => pathname.startsWith(href))?.[1] ??
    "Enquiries";

  return (
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
            <span className="size-2 shrink-0 rounded-xs bg-ledger shadow-[0_0_0_1px_rgba(251,249,243,.4)]" />
            <span className="text-[13.5px] font-semibold">{businessName}</span>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 py-2.5">
          {sections.map((section) => (
            <div key={section.label}>
              <div className="px-2 pt-3 pb-1.5 font-mono text-[9px] tracking-[.18em] text-sidebar-fg/40 uppercase">
                {section.label}
              </div>
              {section.items.map((item) => {
                const active = pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setSidebarOpen(false)}
                    className={cn(
                      "mb-px flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px] font-medium transition-colors",
                      active
                        ? "bg-ledger font-semibold text-white"
                        : "text-sidebar-fg/80 hover:bg-sidebar-fg-strong/5"
                    )}
                  >
                    <item.icon className="size-4 opacity-90" />
                    {item.label}
                    {item.badge ? (
                      <span className="ml-auto rounded-full bg-stamp px-1.5 py-px font-mono text-[10.5px] font-semibold text-white">
                        {item.badge}
                      </span>
                    ) : null}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="flex items-center gap-2.5 border-t border-sidebar-fg/15 px-4.5 py-3.5">
          <div className="flex size-7.5 shrink-0 items-center justify-center rounded-full bg-gold text-xs font-bold text-white">
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
          <div className="glass ml-auto flex min-w-36 items-center gap-2 rounded-full px-3.5 py-1.5 text-[13px] text-ink-faint max-[880px]:min-w-0 max-[880px]:flex-1">
            <Sparkles className="size-3.5 text-gold" />
            Ask Light anything…
          </div>
          <ThemeControl />
        </header>
        <main className="w-full max-w-[1220px] p-5 max-[880px]:p-3.5">{children}</main>
      </div>
    </div>
  );
}
