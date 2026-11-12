import { test, expect } from "@playwright/test";
import { glosRole, isOwnerCell, glosUser } from "../src/lib/instance";

// glosRole fails closed: only an exact "owner", or neither var set (legacy single-user setup), is the owner.
const role = (env: Record<string, string | undefined>) => glosRole(env as NodeJS.ProcessEnv);

test("legacy: neither GLOS_USER nor GLOS_ROLE set is the owner (owner)", () => {
  expect(role({})).toBe("owner");
  expect(isOwnerCell({} as NodeJS.ProcessEnv)).toBe(true);
  expect(glosUser({} as NodeJS.ProcessEnv)).toBe("owner");
});

test("exact GLOS_ROLE=owner is the owner; member is a member", () => {
  expect(role({ GLOS_ROLE: "owner" })).toBe("owner");
  expect(role({ GLOS_USER: "owner", GLOS_ROLE: "owner" })).toBe("owner");
  expect(role({ GLOS_USER: "partner", GLOS_ROLE: "member" })).toBe("member");
});

test("anything else is a member", () => {
  for (const env of [
    { GLOS_USER: "partner" },
    { GLOS_ROLE: "Owner " },
    { GLOS_ROLE: "Owner" },
    { GLOS_ROLE: "admin" },
    { GLOS_ROLE: "" },
    { GLOS_USER: "", GLOS_ROLE: "" },
    { GLOS_USER: "partner", GLOS_ROLE: "owner " },
  ]) expect(role(env), JSON.stringify(env)).toBe("member");
});
