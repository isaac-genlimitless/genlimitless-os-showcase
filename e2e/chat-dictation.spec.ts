import { test, expect, type Page } from "@playwright/test";

// These tests never press Send. They fake the browser speech API so no real mic is needed.
type Mode = "ok" | "denied" | "none";

async function fakeSpeech(page: Page, mode: Mode) {
  await page.addInitScript((m) => {
    const w = window as any;
    if (m === "none") { w.SpeechRecognition = undefined; w.webkitSpeechRecognition = undefined; return; }
    class Fake {
      continuous = false; interimResults = false; lang = "";
      onresult: any = null; onerror: any = null; onend: any = null;
      start() {
        w.__rec = this;
        if (m === "denied") setTimeout(() => { this.onerror?.({ error: "not-allowed" }); this.onend?.(); }, 0);
      }
      stop() { setTimeout(() => this.onend?.(), 0); }
      abort() { this.onend = null; }
    }
    w.SpeechRecognition = Fake; w.webkitSpeechRecognition = Fake;
  }, mode);
}

const say = (page: Page, ...phrases: string[]) =>
  page.evaluate((ps) => {
    const r = (window as any).__rec;
    r.onresult({ resultIndex: 0, results: ps.map((t) => Object.assign([{ transcript: t }], { isFinal: true })) });
  }, phrases);

function trackChatPosts(page: Page) {
  const posts: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && new URL(req.url()).pathname === "/api/chat") posts.push(req.url());
  });
  return posts;
}

test("mic fills the box live, appends to typed text, toggles off, and never sends", async ({ page }) => {
  await fakeSpeech(page, "ok");
  const posts = trackChatPosts(page);
  await page.goto("/");
  const box = page.getByPlaceholder(/Message Chief/);
  await box.fill("Remind me to");
  const mic = page.getByTestId("dictate-btn");
  await expect(mic).toBeVisible();
  await mic.click();
  await expect(mic).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("dictate-status")).toBeVisible();
  await say(page, "call", "the school");
  await expect(box).toHaveValue("Remind me to call the school");
  await mic.click();
  await expect(mic).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("dictate-status")).toHaveCount(0);
  await expect(box).toHaveValue("Remind me to call the school");
  expect(posts).toHaveLength(0);
});

test("typing while listening stops dictation", async ({ page }) => {
  await fakeSpeech(page, "ok");
  await page.goto("/");
  const box = page.getByPlaceholder(/Message Chief/);
  await page.getByTestId("dictate-btn").click();
  await say(page, "hello");
  await box.pressSequentially("!");
  await expect(page.getByTestId("dictate-btn")).toHaveAttribute("aria-pressed", "false");
});

test("mic permission denied shows a short inline message", async ({ page }) => {
  await fakeSpeech(page, "denied");
  await page.goto("/");
  await page.getByTestId("dictate-btn").click();
  await expect(page.getByTestId("dictate-error")).toContainText(/Microphone access is blocked/);
  await expect(page.getByTestId("dictate-btn")).toHaveAttribute("aria-pressed", "false");
});

test("mic button is hidden when speech recognition is unsupported", async ({ page }) => {
  await fakeSpeech(page, "none");
  await page.goto("/");
  await expect(page.getByPlaceholder(/Message Chief/)).toBeVisible();
  await expect(page.getByTestId("dictate-btn")).toHaveCount(0);
});

test("attach and mic buttons are same-size SVG icons, not emoji", async ({ page }) => {
  await fakeSpeech(page, "ok");
  await page.goto("/");
  const mic = page.getByTestId("dictate-btn");
  const attach = page.getByTestId("attach-btn");
  await expect(mic.locator("svg")).toHaveCount(1);
  await expect(attach.locator("svg")).toHaveCount(1);
  const [m, a] = [await mic.boundingBox(), await attach.boundingBox()];
  expect(m && a).toBeTruthy();
  expect(Math.round(m!.width)).toBe(Math.round(a!.width));
  expect(Math.round(m!.height)).toBe(Math.round(a!.height));
  expect(await mic.innerText()).not.toMatch(/[\u{1F300}-\u{1FAFF}⌀-⏿]/u);
  expect(await attach.innerText()).not.toMatch(/[\u{1F300}-\u{1FAFF}⌀-⏿]/u);
  await expect(mic).toHaveAttribute("aria-label", "Start dictation");
});

test("input row fits at 375px with the mic, no overlap and no horizontal scroll", async ({ page }) => {
  await fakeSpeech(page, "ok");
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/");
  const mic = await page.getByTestId("dictate-btn").boundingBox();
  const attach = await page.getByTitle("Attach a file").boundingBox();
  const box = await page.getByPlaceholder(/Message Chief/).boundingBox();
  const send = await page.getByRole("button", { name: "Send", exact: true }).boundingBox();
  expect(mic && attach && box && send).toBeTruthy();
  const comp = await page.getByTestId("chat-composer").boundingBox();
  expect(comp).toBeTruthy();
  for (const b of [attach!, mic!, send!]) {
    expect(b.x).toBeGreaterThanOrEqual(comp!.x);
    expect(b.x + b.width).toBeLessThanOrEqual(comp!.x + comp!.width + 1);
    expect(b.y).toBeGreaterThanOrEqual(box!.y + box!.height - 1);
  }
  expect(attach!.x).toBeLessThan(mic!.x);
  expect(mic!.x).toBeLessThan(send!.x);
  expect(send!.x + send!.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});
