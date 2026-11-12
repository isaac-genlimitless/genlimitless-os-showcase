import { test, expect } from "@playwright/test";
import { sanitizeEmailHtml, emailSrcdoc, htmlLooksReal } from "../src/lib/email-html";

// Pure-function + route-mocked tests: no mailbox, nothing sent, no agent triggered.

const clean = (h: string) => sanitizeEmailHtml(h)!.html;

test("dangerous markup is removed", () => {
  const out = clean(
    `<div onclick="x()">hi</div><script>alert(1)</script><iframe src="https://e.com"></iframe>` +
      `<a href="javascript:alert(1)">bad</a><p style="background:url(http://x/y);width:expression(alert(1));color:red">s</p>` +
      `<form action="/x"><input name="a"></form><svg onload="x()"><circle/></svg><img src="x" onerror="x()">` +
      `<a href="https://ok.com" onmouseover="x()">unclosed <a`
  );
  expect(out).not.toMatch(/<script|<iframe|onclick|onerror|onload|onmouseover|javascript:|<form|<input|<svg|url\(|expression/i);
  expect(out).toContain("hi");
  expect(out).toContain("color:red");
});

test("layout, links, bold, colors and button-style links survive", () => {
  const out = clean(
    `<table width="600"><tr><td bgcolor="#eee"><b>Bold</b> <font color="#ff0000">red</font>` +
      `<a href="https://example.com/x" style="background-color:#1a73e8;padding:10px 20px;color:#fff">Go</a></td></tr></table>`
  );
  expect(out).toContain("<table");
  expect(out).toContain("<b>Bold</b>");
  expect(out).toContain('href="https://example.com/x"');
  expect(out).toContain('target="_blank"');
  expect(out).toContain("noopener");
  expect(out).toContain("background-color:#1a73e8");
  expect(out).toContain("padding:10px 20px");
});

test("remote images are neutralised and tracking pixels dropped", () => {
  const r = sanitizeEmailHtml(`<p>x</p><img src="https://x/y.png" alt="pic"><img src="https://t/p.gif" width="1" height="1">`)!;
  expect(r.hasRemoteImages).toBe(true);
  expect(r.html).toContain('data-remote-src="https://x/y.png"');
  expect(r.html).not.toMatch(/\ssrc=/);
  expect(r.html).not.toContain("t/p.gif");
});

test("emailSrcdoc CSP blocks remote images unless loadImages", () => {
  const html = clean(`<img src="https://x/y.png">`);
  const blocked = emailSrcdoc(html, { loadImages: false });
  expect(blocked).toContain("img-src data:");
  expect(blocked).not.toContain("https:");
  expect(blocked).not.toMatch(/<img src=/);
  const loaded = emailSrcdoc(html, { loadImages: true });
  expect(loaded).toContain("img-src data: https: http:");
  expect(loaded).toContain('<img src="https://x/y.png"');
});

test("long content is not cut and plain text is not treated as real HTML", () => {
  const long = "word ".repeat(2400); // 12,000 chars
  expect(clean(`<p>${long}</p>`).length).toBeGreaterThan(12_000);
  expect(sanitizeEmailHtml("   ")).toBeNull();
  expect(htmlLooksReal("Just some plain text\nwith lines")).toBe(false);
  expect(htmlLooksReal("<div>x</div>")).toBe(true);
});

test("Email tab shows a sandboxed iframe, Load images and Plain text toggle", async ({ page }) => {
  const msg = {
    id: "m1", threadId: "t1", account: "a@example.com", from: "Sender <s@example.com>", to: "a@example.com",
    subject: "Formatted hello", date: new Date().toISOString(), snippet: "snip", text: "Plain body text",
    html: `<p>Hello <b>there</b></p><img data-remote-src="https://x/y.png" alt="">`, hasRemoteImages: true,
  };
  await page.route("**/api/mail-accounts", (r) =>
    r.fulfill({
      json: { configured: true, accounts: [{ email: "a@example.com", label: "A", kind: "gmail_oauth", status: "connected" }] },
    })
  );
  await page.route("**/api/email?**", (r) => {
    const url = r.request().url();
    return r.fulfill({ json: { messages: [msg] } });
    void url;
  });
  await page.goto("/communications");
  await page.getByRole("button", { name: "Email", exact: true }).click();
  await page.getByText("Formatted hello").first().click();
  const frame = page.getByTestId("email-html-frame");
  await expect(frame).toBeVisible({ timeout: 15_000 });
  const sandbox = (await frame.getAttribute("sandbox")) || "";
  expect(sandbox).not.toContain("allow-scripts");
  expect(sandbox).not.toContain("allow-same-origin");
  await expect(page.getByTestId("email-load-images")).toBeVisible();
  expect(await frame.getAttribute("srcdoc")).not.toContain("https: http:");
  await page.getByTestId("email-load-images").click();
  expect(await frame.getAttribute("srcdoc")).toContain("img-src data: https: http:");
  await page.getByTestId("email-view-toggle").click();
  await expect(page.getByText("Plain body text")).toBeVisible();
});
