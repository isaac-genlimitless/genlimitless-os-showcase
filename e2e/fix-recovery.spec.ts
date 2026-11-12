import { test, expect } from "./isolated-test";
import Database from "better-sqlite3";
import { recoverStuckFixes } from "../src/lib/fix-recovery";

// Pure in-memory DB test: never sends anything or runs an agent.
test("recoverStuckFixes puts only 'applying' rows back to pending_approval", () => {
  const mem = new Database(":memory:");
  try {
    mem.exec(`CREATE TABLE fix_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_approval',
      result TEXT
    )`);
    const ins = mem.prepare("INSERT INTO fix_proposals (title, status, result) VALUES (?, ?, ?)");
    ins.run("stuck", "applying", null);
    ins.run("done", "applied", "ok");
    ins.run("nope", "dismissed", null);
    ins.run("waiting", "pending_approval", null);

    expect(recoverStuckFixes(mem)).toBe(1);

    const byTitle = (t: string) =>
      mem.prepare("SELECT status, result FROM fix_proposals WHERE title = ?").get(t) as { status: string; result: string | null };
    expect(byTitle("stuck").status).toBe("pending_approval");
    expect(byTitle("stuck").result).toContain("Server restarted while this was applying");
    expect(byTitle("done")).toEqual({ status: "applied", result: "ok" });
    expect(byTitle("nope")).toEqual({ status: "dismissed", result: null });
    expect(byTitle("waiting")).toEqual({ status: "pending_approval", result: null });

    expect(recoverStuckFixes(mem)).toBe(0);
  } finally {
    mem.close();
  }
});
