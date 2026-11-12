"use client";

import { useState } from "react";
import CodeMap from "@/components/CodeMap";
import CodeGraph from "@/components/CodeGraph";

// Toggle between the existing Code Map view and the Obsidian-style Graph. Display-only.
export default function CodeMapViews() {
  const [view, setView] = useState<"map" | "graph">("map");
  const btn = (v: "map" | "graph", label: string) => (
    <button
      type="button"
      onClick={() => setView(v)}
      aria-pressed={view === v}
      data-testid={`code-view-${v}`}
      className={`px-3 py-1 rounded border text-xs ${view === v ? "border-neutral-300 bg-neutral-800" : "border-neutral-700 opacity-70"}`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex flex-col gap-2 w-full">
      <div className="flex gap-2">{btn("map", "Map")}{btn("graph", "Graph")}</div>
      {view === "graph" ? <CodeGraph /> : <CodeMap />}
    </div>
  );
}
