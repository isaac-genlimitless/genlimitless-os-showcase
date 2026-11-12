import { test, expect } from "@playwright/test";
import { repairSpilledArgs } from "../src/lib/agents/repair-args";

// Run #90 (2026-09-28): a long propose_fix came through as {title, diagnosis} with the other
// parameters written as text inside diagnosis; 4 rejected retries used up the run. Pure, no data.

const KEYS = ["diagnosis", "proposed_change", "files", "size"];

test("pulls parameters spilled into diagnosis back out", () => {
  const out = repairSpilledArgs(
    {
      title: "Add a Todo tab",
      diagnosis:
        'Owner wants a task list.</diagnosis>\n<proposed_change>New `todos` table.\n\nAnd a page.</proposed_change>\n<files>["src/lib/db.ts","src/app/todo/page.tsx"]</files>\n<size>major</size>\n',
    },
    KEYS
  );
  expect(out).toEqual({
    title: "Add a Todo tab",
    diagnosis: "Owner wants a task list.",
    proposed_change: "New `todos` table.\n\nAnd a page.",
    files: ["src/lib/db.ts", "src/app/todo/page.tsx"],
    size: "major",
  });
});

test("leaves well-formed calls alone and keeps explicit parameters", () => {
  const good = { title: "t", diagnosis: "d uses <div> tags", proposed_change: "p", files: ["a.ts"], size: "minor" };
  expect(repairSpilledArgs(good, KEYS)).toEqual(good);
  const partial = repairSpilledArgs({ diagnosis: "d\n<files>a.ts, b.ts</files>", proposed_change: "p", size: "minor" }, KEYS);
  expect(partial).toEqual({ diagnosis: "d", proposed_change: "p", files: ["a.ts", "b.ts"], size: "minor" });
});
