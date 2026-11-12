import { test, expect } from "@playwright/test";
import crypto from "crypto";

// Agent user-management tools. Uses the throwaway accounts.db / data dir only. Never sends, never triggers an agent.

const id = (p: string) => `${p}${crypto.randomBytes(3).toString("hex")}`;

async function setup() {
  const users = await import("../src/lib/accounts/users");
  const admin = await import("../src/lib/accounts/admin");
  const { currentUserId } = await import("../src/lib/accounts/identity");
  const mod = await import("../src/lib/agents/users-admin-tools");
  const { decideApproval } = await import("../src/lib/agents/approvals");
  const registry = await import("../src/lib/agents/registry");
  const owner = currentUserId();
  if (!users.getUser(owner)) users.createUser({ id: owner, display_name: "Owner", role: "owner" });
  const tool = (name: string) => (mod.usersAdminTools as any[]).find((t) => t.name === name);
  const call = async (name: string, args: Record<string, unknown>, as_agent = "chief_of_staff") => {
    const r = await tool(name).handler({ ...args, as_agent }, {});
    const text = r.content[0].text as string;
    return { isError: !!r.isError, text, data: r.isError ? null : JSON.parse(text) };
  };
  return { users, admin, owner, call, decideApproval, registry };
}

test("list_users returns safe fields only", async () => {
  const { users, call } = await setup();
  const u = id("ula");
  users.createUser({ id: u, display_name: "Lister", email: `${u}@example.com` });
  const r = await call("list_users", {});
  expect(r.isError).toBe(false);
  expect(r.text).toContain(u);
  expect(r.text).not.toMatch(/hash|token|totp|secret|backup/i);
});

test("update_user edits and audits; reactivate is direct", async () => {
  const { users, admin, owner, call } = await setup();
  const u = id("uup");
  users.createUser({ id: u, display_name: "Before" });
  const r = await call("update_user", { id: u, display_name: "After" });
  expect(r.data.display_name).toBe("After");
  expect(admin.listAudit(owner, 50).some((a) => a.target === u && a.action.startsWith("user.update"))).toBe(true);
  admin.setStatus(owner, u, "disabled");
  const re = await call("set_user_status", { id: u, status: "active", reason: "back from leave" });
  expect(re.data.status).toBe("active");
});

test("deactivate / role / remove need approval; approve acts, decline does not, duplicates dedupe", async () => {
  const { users, owner, call, decideApproval, registry } = await setup();
  const a = id("uda"), b = id("udb"), c = id("udc");
  for (const x of [a, b, c]) users.createUser({ id: x, display_name: x });

  const d = await call("set_user_status", { id: a, status: "disabled", reason: "left the team" });
  const d2 = await call("set_user_status", { id: a, status: "disabled", reason: "left the team" });
  expect(d.data.request_id).toBe(d2.data.request_id);
  expect(d2.data.duplicate).toBe(true);
  expect(users.getUser(a)!.status).toBe("active");
  await decideApproval(d.data.request_id, "approve");
  expect(users.getUser(a)!.status).toBe("disabled");

  const ro = await call("change_user_role", { id: b, role: "owner", reason: "needs admin access" });
  expect(users.getUser(b)!.role).toBe("member");
  await decideApproval(ro.data.request_id, "approve");
  expect(users.getUser(b)!.role).toBe("owner");

  const rm = await call("remove_user", { id: c, reason: "duplicate account" }, "full_stack_engineer");
  expect(users.getUser(c)!.removed_at).toBeFalsy();
  await decideApproval(rm.data.request_id, "decline");
  expect(users.getUser(c)!.removed_at).toBeFalsy();
  const rm2 = await call("remove_user", { id: c, reason: "duplicate account" });
  await decideApproval(rm2.data.request_id, "approve");
  expect(users.getUser(c)!.removed_at).toBeTruthy();
  expect(registry.getApprovalRequest(rm2.data.request_id)!.status).toBe("approved");
  void owner;
});

test("refusals come back as plain errors; other agents are refused", async () => {
  const { owner, call, users } = await setup();
  const self = await call("set_user_status", { id: owner, status: "active", reason: "no change" });
  expect(self.isError).toBe(true);
  expect(self.text).toBe("self_change");
  const rmAdmin = id("uad");
  users.createUser({ id: rmAdmin, display_name: "Adm", role: "owner" });
  const r = await call("remove_user", { id: rmAdmin, reason: "should refuse" });
  const { decideApproval } = await setup();
  await expect(decideApproval(r.data.request_id, "approve")).rejects.toThrow("cannot_remove_admin");
  const other = await call("list_users", {}, "marketing");
  expect(other.isError).toBe(true);
});

test("tools exist for chief_of_staff and full_stack_engineer only, not assignable, not in member cell", async () => {
  const tools = await import("../src/lib/agents/tools");
  const names = tools.toolNames("users_admin");
  expect(names.sort()).toEqual(["change_user_role", "list_users", "remove_user", "set_user_status", "update_user"]);
  expect(tools.assignableCatalog().some((e: any) => names.includes(e.name))).toBe(false);
  expect(tools.OWNER_ONLY_GROUPS).toContain("users_admin");
});
