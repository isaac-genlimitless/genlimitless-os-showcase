import { test, expect, type Page } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

// Fires a real touch sequence (start, 10 moves, end) at the element matching `sel`.
async function drag(page: Page, sel: string, dy: number) {
  await page.evaluate(({ sel, dy }) => {
    const target = document.querySelector(sel) as Element;
    const mk = (type: string, y: number) => {
      const t = new Touch({ identifier: 1, target, clientX: 100, clientY: y });
      const end = type === "touchend";
      return new TouchEvent(type, { touches: end ? [] : [t], targetTouches: end ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true });
    };
    target.dispatchEvent(mk("touchstart", 200));
    for (let i = 1; i <= 10; i++) target.dispatchEvent(mk("touchmove", 200 + (dy * i) / 10));
    target.dispatchEvent(mk("touchend", 200 + dy));
  }, { sel, dy });
}

async function ready(page: Page) {
  await page.goto("/today");
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("ptr-indicator")).toBeAttached();
  await page.waitForTimeout(500); // let hydration attach the listeners
  await page.evaluate(() => { (window as unknown as { __ptrMark: number }).__ptrMark = 1; });
}
const mark = (page: Page) => page.evaluate(() => (window as unknown as { __ptrMark?: number }).__ptrMark);

test("overscroll CSS lets the pull through on iOS standalone", async ({ page }) => {
  await ready(page);
  const v = await page.evaluate(() => ({
    root: getComputedStyle(document.documentElement).overscrollBehaviorY,
    main: getComputedStyle(document.querySelector("main")!).overscrollBehaviorY,
  }));
  expect(v).toEqual({ root: "none", main: "contain" });
});

test("a long pull from the top reloads the page", async ({ page }) => {
  await ready(page);
  await Promise.all([page.waitForEvent("load"), drag(page, "main", 130)]);
  await page.waitForLoadState("domcontentloaded");
  expect(await mark(page)).toBeUndefined(); // fresh document
});

test("a short pull (under 80px) does not reload", async ({ page }) => {
  await ready(page);
  await drag(page, "main", 50);
  await page.waitForTimeout(800);
  expect(await mark(page)).toBe(1);
  await expect(page.getByTestId("ptr-indicator")).toHaveCSS("opacity", "0");
});

test("no refresh when the page is scrolled down", async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    const m = document.querySelector("main")!;
    const s = document.createElement("div"); s.style.height = "3000px"; m.appendChild(s);
    m.scrollTop = 300;
  });
  await drag(page, "main", 150);
  await page.waitForTimeout(800);
  expect(await mark(page)).toBe(1);
});

test("no refresh when pulling inside an inner scroll area (chat, lists)", async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    const box = document.createElement("div");
    box.id = "ptr-test-inner"; box.style.cssText = "overflow-y:auto;height:100px";
    const tall = document.createElement("div"); tall.style.height = "1000px"; box.appendChild(tall);
    document.querySelector("main")!.appendChild(box);
  });
  await drag(page, "#ptr-test-inner", 150);
  await page.waitForTimeout(800);
  expect(await mark(page)).toBe(1);
});

test("no refresh while a draft is typed (nothing typed can be lost)", async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    const ta = document.createElement("textarea"); ta.id = "ptr-test-draft"; ta.value = "half-written note";
    document.querySelector("main")!.appendChild(ta);
  });
  await drag(page, "main", 150);
  await page.waitForTimeout(800);
  expect(await mark(page)).toBe(1);
});
