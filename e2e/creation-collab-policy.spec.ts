// Pure: the login gate lets only well-formed collaborator links (/c/<32-char token>/...) through without a
// session. The route itself then checks the token; everything else in the OS stays behind login.
import { test, expect } from "@playwright/test";
import { decide, isCollabPath, type HeaderMap, type PolicyInput } from "../src/lib/auth/policy";
import { isCollabPathname } from "../src/components/OsChrome";

const ext: HeaderMap = { host: "os.example", "x-forwarded-for": "203.0.113.9" };
const input = (over: Partial<PolicyInput>): PolicyInput => ({ path: "/", method: "GET", headers: ext, enrolled: true, enforce: true, breakGlass: false, sessionValid: false, ...over });
const T = "A".repeat(32);

test("collaborator link paths pass the login gate; nothing else does", () => {
  for (const path of [`/c/${T}`, `/c/${T}/creation-system`, `/c/${T}/api/creations`, `/c/${T}/api/creations/sandboxes/12/artifacts`, `/c/${T}/api/creations/site3d/v5/site-plan`]) {
    expect(decide(input({ path })), path).toBe("allow");
  }
  expect(decide(input({ path: `/c/${T}/api/creations/sandboxes/1/promote`, method: "POST" }))).toBe("allow");
  for (const path of ["/c/short", `/c/${T}x`, `/c/${T}/../api/chat`, `/c/${T}/a/b/c/d/e/f/g`, "/c", "/api/creations", "/the-creation"]) {
    expect(isCollabPath(path, "GET"), path).toBe(false);
  }
  expect(isCollabPath(`/c/${T}/api/creations`, "DELETE")).toBe(false);
  expect(decide(input({ path: "/api/creations" }))).toBe("unauthorized");
  expect(decide(input({ path: "/api/creations/promotions/1", method: "POST" }))).toBe("unauthorized");
});

test("OS chrome is hidden only on collaborator pages", () => {
  expect(isCollabPathname(`/c/${T}`)).toBe(true);
  expect(isCollabPathname(`/c/${T}/creation-system`)).toBe(true);
  expect(isCollabPathname("/the-creation")).toBe(false);
  expect(isCollabPathname("/c/short")).toBe(false);
});
