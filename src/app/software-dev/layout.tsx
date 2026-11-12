import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { isOwnerCell } from "@/lib/instance";

// Owner-only page: 404 in a member cell (docs/multi-user.md "Member mode").
export default function OwnerOnlyLayout({ children }: { children: ReactNode }) {
  if (!isOwnerCell()) notFound();
  return children;
}
