import { test, expect } from "@playwright/test";

test("login HTML is never cached and its assets load", async ({ request }) => {
  const res = await request.get("/login", { headers: { accept: "text/html" } });
  const cc = res.headers()["cache-control"] ?? "";
  expect(cc).toMatch(/no-store|no-cache/);
  expect(cc).not.toMatch(/s-maxage|max-age=[1-9]/);

  const body = await res.text();
  const refs = Array.from(new Set(body.match(/\/_next\/static\/[^"' ]+\.(?:css|js)/g) ?? []));
  expect(refs.some((r) => r.endsWith(".css"))).toBe(true);

  for (const ref of refs) {
    const asset = await request.get(ref);
    expect(asset.status(), ref).toBe(200);
  }
});
