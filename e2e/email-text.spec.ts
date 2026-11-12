import { test, expect } from "@playwright/test";
import { bestPlainText, looksLikeHtml } from "../src/lib/email-text";

// Pure-function tests: no network, no mailbox, nothing sent.

const HTML_PAGE = `<!doctype html><html xmlns="https://sg.example.com/ls/click?upn=abc"><head><style>.x{color:red}</style></head>
<body><div style="display:none">&#847;&zwnj; &#847;&zwnj;</div><table><tr><td><h1>New IPO: Oura Inc.</h1><p>Trading starts <b>Thursday</b>.</p>
<a href="https://sg.example.com/ls/click?upn=${"x".repeat(200)}">Learn more</a><img src="https://track.example.com/p.gif"></td></tr></table></body></html>`;

test("an HTML page inside the text/plain part is converted to readable text", () => {
  expect(looksLikeHtml(HTML_PAGE)).toBe(true);
  const out = bestPlainText(HTML_PAGE, false);
  expect(out).not.toMatch(/<\/?[a-z]/i);
  expect(out).toContain("New IPO: Oura Inc.");
  expect(out).toContain("Trading starts Thursday");
  expect(out).not.toContain("track.example.com");
  expect(out.length).toBeLessThan(400); // the 200-char tracking URL is dropped
});

test("real plain text passes through unchanged", () => {
  const plain = "Hi Owner,\n\nAre you free Tuesday at 2pm?\n\nThanks,\nSam\n\nP.S. I like <3 and a < b > c.";
  expect(looksLikeHtml(plain)).toBe(false);
  expect(bestPlainText(plain, "<p>ignored html</p>")).toBe(plain);
});

test("an HTML-only email (no plain part) is converted from its html part", () => {
  const out = bestPlainText("", "<html><body><p>Hello <em>there</em></p><ul><li>one</li><li>two</li></ul></body></html>");
  expect(out).toContain("Hello there");
  expect(out).toContain("one");
  expect(out).not.toContain("<");
});

test("invisible pre-header padding characters are removed", () => {
  expect(bestPlainText("Hello͏‌​ world", null)).toBe("Hello world");
});
