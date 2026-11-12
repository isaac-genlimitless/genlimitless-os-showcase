import { test, expect } from "@playwright/test";
import { openTestDb } from "./db-handle";
import db from "../src/lib/db";
import { createPage, updatePage, getPage } from "../src/lib/pages";

// Never presses Send or triggers an agent.
const unique = (p: string) => `${p} ${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test("link API: set, reject bad scheme, clear, agent update, create with link", async ({ request }) => {
  openTestDb().close();
  const p = await createPage({ title: unique("Resume - Test Co - Role"), body: "Body text" });
  const get = async () => (await (await request.get(`/api/files/${p.id}`)).json()).page.link;

  const ok = await request.patch(`/api/files/${p.id}`, { data: { link: "https://example.com/jd" } });
  expect(ok.status()).toBe(200);
  expect(await get()).toBe("https://example.com/jd");

  const bad = await request.patch(`/api/files/${p.id}`, { data: { link: "javascript:alert(1)" } });
  expect(bad.status()).toBe(400);
  expect(await get()).toBe("https://example.com/jd");

  const cleared = await request.patch(`/api/files/${p.id}`, { data: { link: "" } });
  expect(cleared.status()).toBe(200);
  expect(await get()).toBeNull();

  const before = getPage(p.id)!.body;
  await updatePage(p.id, { link: "https://a.b/c" }, { source: "agent" });
  expect(getPage(p.id)!.link).toBe("https://a.b/c");
  expect(getPage(p.id)!.body).toBe(before);

  const c = await createPage({ title: unique("Created"), link: "https://x.y/z" });
  expect(getPage(c.id)!.link).toBe("https://x.y/z");
});

test("link chip UI: add then clear", async ({ page }) => {
  openTestDb().close();
  const p = await createPage({ title: unique("Resume - Test Co - Role") });
  await page.goto(`/files?id=${p.id}`);
  await page.getByTestId("add-link").click();
  await page.getByTestId("page-link-input").fill("https://example.com/jd");
  await page.getByTestId("page-link-input").press("Enter");
  const chip = page.getByTestId("page-link-chip");
  await expect(chip).toBeVisible();
  await expect(chip.locator("a")).toHaveAttribute("href", "https://example.com/jd");
  await expect(chip).toContainText("JD link");
  await chip.hover();
  await page.getByTestId("clear-link").click();
  await expect(chip).toHaveCount(0);
  await expect(page.getByTestId("add-link")).toBeVisible();
});

test("backfill UPDATE is guarded by title match and never overwrites", async () => {
  openTestDb().close();
  const p = await createPage({ title: unique("Resume - Acme") });
  const bf = db.prepare(`UPDATE docs SET link = ? WHERE id = ? AND link IS NULL AND title LIKE ?`);
  bf.run("https://one.example/a", p.id, "%NoSuchCompany%");
  expect(getPage(p.id)!.link).toBeNull();
  bf.run("https://one.example/a", p.id, "%Acme%");
  expect(getPage(p.id)!.link).toBe("https://one.example/a");
  bf.run("https://two.example/b", p.id, "%Acme%");
  expect(getPage(p.id)!.link).toBe("https://one.example/a");
});
