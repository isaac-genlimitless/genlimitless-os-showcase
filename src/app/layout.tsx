import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Montserrat } from "next/font/google";
import "./globals.css";
import Sidebar from "@/components/Sidebar";
import ChatDock from "@/components/ChatDock";
import RecordingPill from "@/components/RecordingPill";
import BridgeBanner from "@/components/BridgeBanner";
import OsChrome from "@/components/OsChrome";
import ImpersonationBanner from "@/components/ImpersonationBanner";
import PullToRefresh from "@/components/PullToRefresh";
import { buildId, PWA_HEAL_JS } from "@/lib/pwa-heal";
import { CellProvider } from "@/components/CellContext";
import { isOwnerCell, ownerName } from "@/lib/instance";

// Self-hosted at build time: the browser no longer waits on fonts.googleapis.com before drawing the page.
const montserrat = Montserrat({ subsets: ["latin"], weight: ["300", "400", "500", "600", "700", "800"], display: "swap", variable: "--font-montserrat-loaded" });

export const dynamic = "force-dynamic"; // HTML must never be cached: a phone holding HTML from an older build points at JS/CSS hashes that no longer exist after a deploy.

export const metadata: Metadata = {
  title: "GenLimitless AI OS",
  description: `${ownerName()}'s internal AI operating system for GenLimitless`,
  applicationName: "GenLimitless OS",
  // Home-screen app on iPhone: opens full screen without Safari's address bar.
  appleWebApp: { capable: true, title: "GenLimitless", statusBarStyle: "black" },
  // Listing icons here replaces the file-based ones, so keep the tab icon (src/app/icon.png) too.
  icons: { icon: { url: "/icon.png", type: "image/png" }, apple: "/app-icons/apple-touch-icon.png" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
    { media: "(prefers-color-scheme: light)", color: "#f6f5f1" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`h-full antialiased ${montserrat.variable}`} data-build={buildId()}>
      <head><script dangerouslySetInnerHTML={{ __html: PWA_HEAL_JS }} /></head>
      <body className="h-dvh flex flex-col overflow-hidden bg-background text-foreground">
        <CellProvider owner={isOwnerCell()} name={ownerName()}>
        <PullToRefresh />
        <OsChrome><ImpersonationBanner /></OsChrome>
        {isOwnerCell() && <OsChrome><BridgeBanner /></OsChrome>}
        <div className="relative flex flex-1 min-h-0">
          <OsChrome><Sidebar /></OsChrome>
          <main className="flex-1 min-w-0 pt-14 md:pt-0 overflow-y-auto overflow-x-hidden">{children}</main>
          <OsChrome><ChatDock /></OsChrome>
        </div>
        <OsChrome><RecordingPill /></OsChrome>
        </CellProvider>
      </body>
    </html>
  );
}
