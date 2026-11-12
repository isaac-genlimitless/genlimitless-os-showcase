import { test, expect, request as pwRequest } from "@playwright/test";

// Never presses Send or triggers an agent.
test("share viewers can highlight and comment; revoke closes everything", async ({ browser, request, baseURL, page }) => {
  const src = await request.get("/api/files/370");
  let body = "Resume body for the shared comment test. Experienced engineer shipping product.";
  if (src.ok()) {
    const j = await src.json();
    body = (j.page?.body ?? j.body ?? body) || body;
  }
  const created = await request.post("/api/files", {
    data: { title: "E2E Resume and Cover Letter - Cresta (share comments)", body, kind: "page" },
  });
  expect(created.ok()).toBeTruthy();
  const cj = await created.json();
  const id = (cj.page?.id ?? cj.id) as number;
  const sh = await (await request.post(`/api/files/${id}/share`, { data: { enabled: true } })).json();
  const path = sh.path as string;
  const token = path.split("/").pop()!;
  const before = JSON.stringify(await (await request.get(`/api/files/${id}`)).json());

  const ctx = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const anon = await ctx.newPage();
  const resp = await anon.goto(path);
  const csp = resp!.headers()["content-security-policy"];
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("form-action 'none'");
  expect(csp).toContain("frame-ancestors 'none'");

  const articleBefore = await anon.locator("body").innerText();
  await anon.evaluate(() => {
    const p = document.querySelector("p");
    const r = document.createRange();
    r.setStart(p!.firstChild!, 0);
    r.setEnd(p!.firstChild!, Math.min(6, p!.firstChild!.textContent!.length));
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
    document.dispatchEvent(new Event("selectionchange"));
    document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await anon.getByRole("button", { name: /^comment$/i }).first().click();
  anon.once("dialog", (d) => d.accept("Guest Tester"));
  const box = anon.locator("textarea").first();
  await box.fill("<b>x</b>");
  await anon.getByRole("button", { name: /^(save|comment|post)$/i }).last().click();
  await expect.poll(() => anon.evaluate(() => localStorage.getItem("gl_comment_name"))).toBe("Guest Tester");
  await expect.poll(() => anon.evaluate(() => (CSS as any).highlights.size)).toBe(1);
  await expect(anon.getByText("<b>x</b>")).toBeVisible();

  await anon.reload();
  await expect.poll(() => anon.evaluate(() => (CSS as any).highlights.size)).toBe(1);
  expect(await anon.locator("body > h1, body > p").first().isVisible()).toBeTruthy();
  expect(articleBefore.length).toBeGreaterThan(0);

  // Owner sees it with the Guest badge; page body unchanged.
  await page.goto(`/files?id=${id}`);
  await expect(page.getByText("Guest").first()).toBeVisible({ timeout: 15000 });
  expect(JSON.stringify(await (await request.get(`/api/files/${id}`)).json())).toBe(before);

  // Anonymous cannot reach owner routes when auth is enforced.
  const raw = await pwRequest.newContext({ baseURL });
  const probe = await raw.get(`/api/files/${id}/comments`, { maxRedirects: 0 });
  if (probe.status() === 401 || probe.status() === 307) {
    expect([401, 307, 302]).toContain((await raw.get(`/api/files/${id}`, { maxRedirects: 0 })).status());
    expect([401, 307, 302, 303]).toContain((await raw.get("/files", { maxRedirects: 0 })).status());
  }

  // Revoke
  await request.post(`/api/files/${id}/share`, { data: { enabled: false } });
  expect((await raw.get(path)).status()).toBe(404);
  expect((await raw.get(`${path}/comments.js`)).status()).toBe(404);
  expect((await raw.get(`/share/${token}/comments`)).status()).toBe(404);
  expect((await raw.post(`/share/${token}/comments`, { data: { text: "x", quote: "x" } })).status()).toBe(404);
  await raw.dispose();
  await ctx.close();
});
