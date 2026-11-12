import { test, expect } from "@playwright/test";
import db from "../src/lib/db";
import {
  buildCommitmentsBriefingSection,
  commitmentsOverview,
  getCommitment,
  listCommitments,
  markNudged,
  recordCommitment,
  staleWaitingOn,
  updateCommitment,
} from "../src/lib/commitments";
import { getTask, updateTask } from "../src/lib/tasks";
import { permsFor } from "../src/lib/agents/runtime";
import { getAgent } from "../src/lib/agents/registry";

// Non-UI: the runner's throwaway DB (playwright.config.ts). Never sends, never runs an agent.

const u = (p: string) => `${p} ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

test("owner_owes creates a linked task; ticking the task closes the commitment", () => {
  const what = u("Send Acme the pricing deck");
  const c = recordCommitment({ direction: "owner_owes", person: "Dana (dana@acme.test)", what, due_date: "2026-11-06", source: "email", source_excerpt: "I'll send it Friday" }, "agent:chief_of_staff");
  expect(c.task_id).toBeTruthy();
  const t = getTask(c.task_id!)!;
  expect(t.title).toBe(what);
  expect(t.category).toBe("Commitments");
  expect(t.due_date).toBe("2026-11-06");
  updateTask(t.id, { status: "done" });
  expect(listCommitments({ status: "all" }).find((x) => x.id === c.id)!.status).toBe("done");
});

test("owed_to_owner has no task; done via update closes; duplicates return the existing one", () => {
  const what = u("Get back to Owner about the contract");
  const a = recordCommitment({ direction: "owed_to_owner", person: "Ray", what, source: "text" });
  expect(a.task_id).toBeNull();
  const b = recordCommitment({ direction: "owed_to_owner", person: "ray", what, due_date: "2026-11-10" });
  expect(b.id).toBe(a.id);
  expect(b.duplicate).toBe(true);
  expect(getCommitment(a.id)!.due_date).toBe("2026-11-10"); // filled in, not duplicated
  const done = updateCommitment(a.id, { status: "done", close_note: "contract arrived" });
  expect(done.status).toBe("done");
  expect(done.closed_at).toBeTruthy();
  expect(updateCommitment(a.id, { status: "open" }).closed_at).toBeNull();
});

test("completing an owner_owes commitment completes its task", () => {
  const c = recordCommitment({ direction: "owner_owes", person: "Mom", what: u("Call about Thanksgiving") });
  updateCommitment(c.id, { status: "done" });
  expect(getTask(c.task_id!)!.status).toBe("done");
});

test("validation: direction, person, what and real dates", () => {
  expect(() => recordCommitment({ direction: "sideways", person: "x", what: "y" })).toThrow(/direction/);
  expect(() => recordCommitment({ direction: "owner_owes", person: " ", what: "y" })).toThrow(/person/);
  expect(() => recordCommitment({ direction: "owner_owes", person: "x", what: "" })).toThrow(/what/);
  expect(() => recordCommitment({ direction: "owner_owes", person: "x", what: "y", due_date: "2026-02-30" })).toThrow(/due_date/);
});

test("stale waiting-on: past due or 7+ days old, not nudged in 3 days; briefing lists them", () => {
  const overdue = recordCommitment({ direction: "owed_to_owner", person: u("Vendor"), what: u("Send invoice"), due_date: "2026-11-01" });
  const old = recordCommitment({ direction: "owed_to_owner", person: u("Coach"), what: u("Share schedule") });
  db.prepare(`UPDATE commitments SET created_at='2026-10-20 12:00:00' WHERE id=?`).run(old.id);
  const fresh = recordCommitment({ direction: "owed_to_owner", person: u("Friend"), what: u("Send photos") });
  const stale = staleWaitingOn("2026-11-04").map((c) => c.id);
  expect(stale).toContain(overdue.id);
  expect(stale).toContain(old.id);
  expect(stale).not.toContain(fresh.id);
  markNudged(overdue.id);
  db.prepare(`UPDATE commitments SET last_nudged_at='2026-11-03 12:00:00' WHERE id=?`).run(overdue.id);
  expect(staleWaitingOn("2026-11-04").map((c) => c.id)).not.toContain(overdue.id);
  expect(buildCommitmentsBriefingSection("2026-11-04")).toContain("Waiting on");
  const mine = recordCommitment({ direction: "owner_owes", person: u("Neighbor"), what: u("Send talk outline"), due_date: "2026-11-02" });
  expect(commitmentsOverview("2026-11-04").overdue.map((c) => c.id)).toContain(mine.id);
  expect(buildCommitmentsBriefingSection("2026-11-04")).toContain("Overdue promises");
});

test("Chief carries the commitment tools and the read-only Autopilot list", () => {
  const chief = permsFor(getAgent("chief_of_staff")!).mcp;
  for (const t of ["list_commitments", "record_commitment", "update_commitment", "list_autopilot"]) expect(chief.has(t)).toBe(true);
});
