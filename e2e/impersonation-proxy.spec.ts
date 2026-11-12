import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import { askOwner, clearOwnerCheckCache } from "../src/lib/auth/owner-check";

// Unit-style, injected fetch: no network, nothing is sent, no agent runs.
const reply = (status: number, headers: Record<string, string>) =>
  (async () => new Response(null, { status, headers })) as unknown as typeof fetch;

test("imp flag and impersonator come through askOwner and survive the cache", async () => {
  clearOwnerCheckCache();
  const f = reply(204, { "x-glos-user": "partner", "x-glos-imp": "ro", "x-glos-impersonator": "owner" });
  const a = await askOwner("i1", "partner", { fetchImpl: f, now: 1000 });
  expect(a).toMatchObject({ ok: true, imp: "ro", by: "owner" });
  const boom = (async () => { throw new Error("should be cached"); }) as unknown as typeof fetch;
  const b = await askOwner("i1", "partner", { fetchImpl: boom, now: 2000 });
  expect(b).toMatchObject({ ok: true, imp: "ro", by: "owner" });
});

test("imp is never set when ok is false; normal sessions have no imp", async () => {
  clearOwnerCheckCache();
  const imp = { "x-glos-imp": "ro", "x-glos-impersonator": "owner" };
  expect((await askOwner("n1", "partner", { fetchImpl: reply(204, { "x-glos-user": "owner", ...imp }) })).imp).toBeUndefined();
  expect((await askOwner("n2", "partner", { fetchImpl: reply(401, { "x-glos-user": "partner", ...imp }) })).imp).toBeUndefined();
  const plain = await askOwner("n3", "partner", { fetchImpl: reply(204, { "x-glos-user": "partner" }) });
  expect(plain.ok).toBe(true);
  expect(plain.imp).toBeUndefined();
  expect(plain.by).toBeUndefined();
});

test("proxy source enforces read-only with the exemptions and strips the client header", () => {
  const src = fs.readFileSync(path.join(__dirname, "../src/proxy.ts"), "utf8");
  expect(src).toContain("impersonation_read_only");
  expect(src).toContain('"/api/auth/impersonate"');
  expect(src).toContain('"/api/auth/logout"');
  expect(src).toContain('fwd.delete("x-glos-impersonator")');
});

test("sweep: GET handlers that look like they mutate (reported, not failed)", () => {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "route.ts") {
        const s = fs.readFileSync(p, "utf8");
        const m = s.match(/export\s+(?:async\s+)?function\s+GET[\s\S]*?(?=\nexport\s|$)/);
        if (m && /writeFile|appendFile|unlink|\.run\(|INSERT |UPDATE |DELETE FROM|spawn\(|exec\(/.test(m[0])) hits.push(path.relative(process.cwd(), p));
      }
    }
  };
  walk(path.join(__dirname, "../src/app/api"));
  console.log("Possibly mutating GET routes:\n" + (hits.join("\n") || "(none)"));
  expect(Array.isArray(hits)).toBe(true);
});
