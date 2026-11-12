import { test, expect } from "@playwright/test";
import { explainTokenRejection } from "../src/lib/selftest-target";

const base = { status: 401, localFp: "a915891e", host: "http://localhost:3100" };

test("matching fp but 401 -> session/route issue", () => {
  expect(explainTokenRejection({ ...base, serverFp: "a915891e", body: "" })).toContain("session/route issue");
});
test("different fp -> MISMATCH", () => {
  expect(explainTokenRejection({ ...base, serverFp: "deadbeef", body: "" })).toContain("MISMATCH");
});
test("no fp + login_required -> not loopback or old build", () => {
  const m = explainTokenRejection({ ...base, serverFp: "none", body: '{"error":"login_required"}' });
  expect(m).toContain("not seen as loopback");
  expect(m).toContain("restart from /opt/genlimitless-os/current");
});
test("no fp, no login_required -> something else", () => {
  expect(explainTokenRejection({ ...base, serverFp: "none", body: "nope" })).toContain("something other than this app");
});
