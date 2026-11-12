import fs from "fs";
import os from "os";
import path from "path";

// Renders a static HTML string to a real PDF with headless Chromium (playwright-core).
// JavaScript is disabled in the page and nothing is fetched, so page text can't run anything.
// If this throws, the export route falls back to the built-in writer in simple-pdf.ts.

const CHROME_APP = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ARGS = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"];

let queue: Promise<unknown> = Promise.resolve();

/** Chromium builds installed by `playwright install`, wherever HOME points (headless shell first). */
function installedChromes(): string[] {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), ".cache/ms-playwright"), "/opt/genlimitless-os/.cache/ms-playwright"].filter(
    (r): r is string => !!r && r !== "0",
  );
  const found: string[] = [];
  for (const root of roots) {
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const d of dirs.sort().reverse()) {
      const exe = d.startsWith("chromium_headless_shell-")
        ? path.join(root, d, "chrome-headless-shell-linux64/chrome-headless-shell")
        : d.startsWith("chromium-")
          ? path.join(root, d, "chrome-linux64/chrome")
          : "";
      if (exe && fs.existsSync(exe) && !found.includes(exe)) found.push(exe);
    }
  }
  return found.sort((a, b) => Number(b.includes("headless")) - Number(a.includes("headless")));
}

const SYSTEM_CHROMES = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-stable", "/snap/bin/chromium"];

export async function launch(firstPath?: string) {
  const { chromium } = await import("playwright-core");
  const base = { args: ARGS, timeout: 20_000 };
  const attempts: Array<[string, () => ReturnType<typeof chromium.launch>]> = [
    ...(firstPath ? [[firstPath, () => chromium.launch({ ...base, executablePath: firstPath })] as [string, () => ReturnType<typeof chromium.launch>]] : []),
    ["default", () => chromium.launch(base)],
    ...installedChromes().map((p): [string, () => ReturnType<typeof chromium.launch>] => [p, () => chromium.launch({ ...base, executablePath: p })]),
    ...SYSTEM_CHROMES.filter((p) => fs.existsSync(p)).map((p): [string, () => ReturnType<typeof chromium.launch>] => [p, () => chromium.launch({ ...base, executablePath: p })]),
    ["channel chrome", () => chromium.launch({ ...base, channel: "chrome" })],
    ["mac chrome", () => chromium.launch({ ...base, executablePath: CHROME_APP })],
  ];
  const errors: string[] = [];
  for (const [label, attempt] of attempts) {
    try {
      return await attempt();
    } catch (e) {
      errors.push(`${label}: ${String((e as Error).message).split("\n")[0].slice(0, 200)}`);
    }
  }
  throw new Error(`PDF engine unavailable (${errors.join(" | ")})`);
}

async function render(html: string): Promise<Buffer> {
  const browser = await launch();
  try {
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    page.setDefaultTimeout(30_000);
    await page.setContent(html, { waitUntil: "load" });
    await page.emulateMedia({ media: "print" });
    return await page.pdf({
      format: "Letter",
      printBackground: true,
      displayHeaderFooter: false,
      preferCSSPageSize: true,
      margin: { top: "0.7in", right: "0.9in", bottom: "0.7in", left: "0.9in" },
    });
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/** One render at a time so repeated clicks don't spawn several Chromes. */
export function htmlToPdf(html: string): Promise<Buffer> {
  const run = queue.then(() => render(html));
  queue = run.catch(() => undefined);
  return run;
}
