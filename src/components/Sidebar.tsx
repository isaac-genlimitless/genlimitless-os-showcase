"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useOwnerCell } from "./CellContext";

const ICON_PROPS = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const icons = {
  today: <svg {...ICON_PROPS}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>,
  decisions: <svg {...ICON_PROPS}><path d="M9 11l3 3 8-8" /><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" /></svg>,
  chat: <svg {...ICON_PROPS}><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" /></svg>,
  files: <svg {...ICON_PROPS}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /></svg>,
  creation: <svg {...ICON_PROPS}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" /><path d="M19 16l.7 1.8L21.5 18.5l-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7L19 16z" /></svg>,
  calendar: <svg {...ICON_PROPS}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>,
  tasks: <svg {...ICON_PROPS}><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M8 12.5l2.7 2.7L16 9.5" /></svg>,
  budgets: <svg {...ICON_PROPS}><circle cx="12" cy="12" r="9" /><path d="M14.8 9.2c-.4-1-1.4-1.5-2.8-1.5-1.6 0-2.7.8-2.7 2s1 1.7 2.7 2.1c1.8.4 2.9.9 2.9 2.2 0 1.2-1.2 2-2.9 2-1.5 0-2.6-.6-3-1.7M12 6v1.7M12 16.3V18" /></svg>,
  meetings: <svg {...ICON_PROPS}><rect x="3" y="6" width="12" height="12" rx="2" /><path d="M15 10.5l6-3.5v10l-6-3.5" /></svg>,
  team: <svg {...ICON_PROPS}><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><circle cx="17" cy="9" r="2.4" /><path d="M17 14.2c2.4 0 4.2 1.9 4.2 4.3" /></svg>,
  comms: <svg {...ICON_PROPS}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3.5 7l8.5 6 8.5-6" /></svg>,
  analytics: <svg {...ICON_PROPS}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>,
  jobs: <svg {...ICON_PROPS}><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M3 13h18" /></svg>,
  partner: <svg {...ICON_PROPS}><rect x="3" y="8" width="18" height="4" rx="1" /><path d="M5 12v8h14v-8M12 8v12M12 8c-1.5-3-5-3.5-5-1.5S10 8 12 8zM12 8c1.5-3 5-3.5 5-1.5S14 8 12 8z" /></svg>,
};

// ownerOnly items are hidden in member cells (docs/multi-user.md "Member mode").
const NAV: { href: string; label: string; icon: React.ReactNode; ownerOnly?: boolean }[] = [
  { href: "/", label: "Chat", icon: icons.chat },
  { href: "/today", label: "Today", icon: icons.today },
  { href: "/decisions", label: "Decisions", icon: icons.decisions },
  { href: "/files", label: "Files", icon: icons.files },
  { href: "/the-creation", label: "The Creation", icon: icons.creation },
  { href: "/calendar", label: "Calendar", icon: icons.calendar },
  { href: "/tasks", label: "Tasks", icon: icons.tasks },
  { href: "/meetings", label: "Meetings", icon: icons.meetings },
  { href: "/team", label: "Team", icon: icons.team },
  { href: "/communications", label: "Communications", icon: icons.comms },
  { href: "/settings", label: "Settings", icon: icons.analytics },
];

export default function Sidebar() {
  const pathname = usePathname();
  const owner = useOwnerCell();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  const content = (
    <>
      <div className="px-5 py-6 border-b border-panel-border">
        <div className="font-display text-xl tracking-wide leading-none whitespace-nowrap">
          <span className="text-foreground">GEN</span>
          <span className="text-accent">LIMITLESS</span>
        </div>
        <div className="text-xs text-muted mt-1">AI Operating System</div>
      </div>
      <nav className="flex-1 py-4">
        {NAV.filter((item) => owner || !item.ownerOnly).map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(item.href + "/") || (item.href === "/settings" && pathname.startsWith("/analytics"));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`px-5 py-3 md:py-2.5 min-h-11 md:min-h-0 text-sm flex items-center gap-3 transition-colors rounded-r-lg ${
                active
                  ? "text-accent border-l-2 border-gold bg-wash-2"
                  : "text-foreground/80 border-l-2 border-transparent hover:bg-wash-1"
              }`}
            >
              <span aria-hidden data-testid="nav-icon" className="w-6 h-6 shrink-0 flex items-center justify-center text-accent">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="px-5 py-4 border-t border-panel-border text-xs text-muted">
        Chief: live · <kbd className="text-[10px]">⌘J</kbd>
      </div>
    </>
  );

  return (
    <>
      <aside data-app-nav className="hidden md:flex w-56 shrink-0 bg-panel border-r border-panel-border flex-col">
        {content}
      </aside>

      <header data-app-nav className="md:hidden absolute top-0 inset-x-0 z-40 h-14 bg-panel border-b border-panel-border flex items-center gap-3 px-3">
        <button
          type="button"
          aria-label="Open menu"
          aria-expanded={menuOpen}
          data-testid="mobile-menu-button"
          onClick={() => setMenuOpen(true)}
          className="w-11 h-11 flex items-center justify-center text-xl"
        >
          ☰
        </button>
        <div className="font-display text-2xl tracking-wide leading-none">
          <span className="text-foreground">GEN</span>
          <span className="text-accent">LIMITLESS</span>
        </div>
      </header>

      {menuOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/50"
            data-testid="mobile-nav-backdrop"
            onClick={() => setMenuOpen(false)}
          />
          <div
            data-testid="mobile-nav"
            className="fixed top-0 left-0 bottom-0 w-72 max-w-[85vw] bg-panel overflow-y-auto flex flex-col"
          >
            <button
              type="button"
              aria-label="Close menu"
              onClick={() => setMenuOpen(false)}
              className="absolute top-2 right-2 w-11 h-11 flex items-center justify-center text-xl"
            >
              ✕
            </button>
            {content}
          </div>
        </div>
      )}
    </>
  );
}
