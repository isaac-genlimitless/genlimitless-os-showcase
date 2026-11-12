"use client";
import { createContext, useContext, type ReactNode } from "react";

// Which cell is serving this page (see src/lib/instance.ts). Set once by the root layout from the server env.
const Ctx = createContext<{ owner: boolean; name: string }>({ owner: true, name: "Owner" });

export function CellProvider({ owner, name, children }: { owner: boolean; name: string; children: ReactNode }) {
  return <Ctx.Provider value={{ owner, name }}>{children}</Ctx.Provider>;
}

/** False in a member cell: owner-only nav items, tabs and cards are hidden. */
export const useOwnerCell = () => useContext(Ctx).owner;
export const useOwnerName = () => useContext(Ctx).name;
