import fs from "fs";
import path from "path";
import { test as plainTest, expect } from "@playwright/test";
import { UI_TABS, snapshotTab } from "../src/lib/ui-snapshot";

// Never presses Send/Approve and never triggers an agent. Only issues GETs / reads source text.

plainTest("every tab snapshot returns tab and source_endpoints without throwing", async ({ baseURL }) => {
  for (const tab of UI_TABS) {
    const snap = await snapshotTab(tab, { baseUrl: baseURL });
    expect(snap.tab).toBe(tab);
    expect(Array.isArray(snap.source_endpoints)).toBe(true);
    expect(snap.summary).toBeTruthy();
    expect(Array.isArray(snap.items)).toBe(true);
  }
});

plainTest("the snapshot module only ever issues GET requests", () => {
  const src = fs.readFileSync(path.join(__dirname, "../src/lib/ui-snapshot.ts"), "utf8");
  const fetches = src.match(/fetch\(/g) || [];
  expect(fetches).toHaveLength(1);
  expect(src).toMatch(/method:\s*"GET"/);
  expect(src).not.toMatch(/method:\s*["'`](POST|PUT|PATCH|DELETE)/i);
  expect(src).not.toMatch(/\.(run|exec)\(|INSERT\s|UPDATE\s|DELETE\s/);
});
