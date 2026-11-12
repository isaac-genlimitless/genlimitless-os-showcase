import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";

// GET only: never sends or triggers agents.
test("uploads: missing file is 404", async ({ request }) => {
  const res = await request.get("/api/uploads/does-not-exist.png");
  expect(res.status()).toBe(404);
});

test("uploads: served with sandbox CSP and nosniff", async ({ request }) => {
  const dir = path.join(process.cwd(), "data", "uploads");
  const name = fs.existsSync(dir)
    ? fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith(".png"))
    : undefined;
  test.skip(!name, "no png upload fixture present");
  const res = await request.get("/api/uploads/" + encodeURIComponent(name!));
  test.skip(!res.ok(), "upload not served by this server's data dir");
  expect(res.headers()["content-security-policy"]).toContain("sandbox");
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
});
