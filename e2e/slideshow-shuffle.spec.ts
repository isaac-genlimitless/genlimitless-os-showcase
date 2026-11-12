import { test, expect } from "./isolated-test";
import type { Page } from "@playwright/test";
import { renderSlideshowPlayer } from "../src/lib/slideshow/player";

// Never presses Send or triggers an agent. Loads the player HTML directly (no network, no server routes).
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

type Q = { id: string; type: "quote"; text: string; name: string };
const quotes = (n: number): Q[] => Array.from({ length: n }, (_, k) => ({ id: "q" + (k + 1), type: "quote", text: "Q" + (k + 1), name: "N" }));

async function load(page: Page, slides: Parameters<typeof renderSlideshowPlayer>[0]["slides"]) {
  await page.setContent(renderSlideshowPlayer({ title: "T", slides, photoUrl: () => PNG }));
}

async function readOrder(page: Page, n: number): Promise<string[]> {
  if ((await page.locator("#play").getAttribute("aria-label")) === "Pause") await page.click("#play");
  const out: string[] = [];
  for (let k = 0; k < n; k++) {
    const q = page.locator(".slide .qt");
    const label = (await q.count()) ? await q.innerText() : await page.locator(".slide .cap").innerText();
    out.push(label);
    await page.click("#next");
  }
  return out;
}

test("shuffle keeps every slide, restore returns original order", async ({ page }) => {
  await load(page, [...quotes(6), { id: "p1", type: "photo", photo: "x", caption: "P1" }]);
  const original = await readOrder(page, 7);
  await page.click("#shuf");
  await expect(page.locator("#orig")).toBeVisible();
  await expect(page.locator("#shuf")).toHaveAttribute("aria-pressed", "true");
  const shuffled = await readOrder(page, 7);
  expect([...shuffled].sort()).toEqual([...original].sort());
  await page.click("#orig");
  expect(await readOrder(page, 7)).toEqual(original);
  await expect(page.locator("#orig")).toBeHidden();
});

test("shuffle is Fisher-Yates", async ({ page }) => {
  await load(page, quotes(4));
  await page.evaluate(() => { Math.random = () => 0; });
  await page.click("#shuf");
  expect(await readOrder(page, 4)).toEqual(["Q2", "Q3", "Q4", "Q1"]);
  await page.evaluate(() => { Math.random = () => 0.999999; });
  await page.click("#shuf");
  expect(await readOrder(page, 4)).toEqual(["Q1", "Q2", "Q3", "Q4"]);
});

test("shuffle actually reorders over several tries", async ({ page }) => {
  await load(page, quotes(8));
  const original = await readOrder(page, 8);
  let differed = false;
  for (let t = 0; t < 30 && !differed; t++) {
    await page.click("#shuf");
    const o = await readOrder(page, 8);
    if (o.join() !== original.join()) differed = true;
  }
  expect(differed).toBe(true);
});

test("single slide: shuffle disabled", async ({ page }) => {
  await load(page, quotes(1));
  await expect(page.locator("#shuf")).toBeDisabled();
});

test("shared player carries the shuffle button for both pages", () => {
  const slides = quotes(2);
  expect(renderSlideshowPlayer({ title: "Normal", slides, photoUrl: (p) => p })).toContain('id="shuf"');
  expect(renderSlideshowPlayer({ title: "Partner", slides, photoUrl: (p) => p, backHref: "/x", banner: "Hi" })).toContain('id="shuf"');
});
