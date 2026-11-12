import type { Metadata } from "next";
import type { ReactNode } from "react";

// Collaborator pages: no OS chrome (see OsChrome), never indexed, and the private link never leaks via Referer.
export const metadata: Metadata = {
  title: "The Creation",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function CollabLayout({ children }: { children: ReactNode }) {
  return <div className="h-full flex flex-col" data-testid="collab-shell">{children}</div>;
}
