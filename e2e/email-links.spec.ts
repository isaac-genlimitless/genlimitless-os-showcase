import { test, expect } from "@playwright/test";
import { renderEmailBody } from "../src/lib/mail";

// Unit-style check: never calls sendEmail or triggers the agent.

test("renderEmailBody hyperlinks link text and hides raw URLs in HTML", () => {
  const { html, text } = renderEmailBody("Hi\n[watch](https://x.com/a?b=1&c=2)");
  expect(html).toContain('<a href="https://x.com/a?b=1&amp;c=2">watch</a>');
  // No bare URL text outside the href attribute
  expect(html.replace(/href="[^"]*"/g, "")).not.toContain("https://x.com");
  expect(text).toContain("watch (https://x.com/a?b=1&c=2)");
});
