// Unit tests for LinkedIn paste links. No network, never sends or triggers an agent.
import test from "node:test";
import assert from "node:assert/strict";
import { buildPasteText, extractProfileLinks } from "./paste-links";

const a = (href: string, text: string) => `<a href="${href}">${text}</a>`;

test("strips tracking query", () => {
  const l = extractProfileLinks(a("https://www.linkedin.com/in/jane-doe/?miniProfileUrn=x&amp;trk=y#h", "Jane Doe"));
  assert.deepEqual(l, [{ url: "https://www.linkedin.com/in/jane-doe", name: "Jane Doe" }]);
});

test("dedupes same profile", () => {
  const html = a("https://www.linkedin.com/in/jane-doe?trk=1", "Jane Doe") + a("https://www.linkedin.com/in/jane-doe", "Jane Doe");
  assert.equal(extractProfileLinks(html).length, 1);
});

test("two people each get link under own name", () => {
  const html = a("/in/jane", "Jane Doe") + a("/in/bob", "Bob Ray");
  const out = buildPasteText("Jane Doe\nhi\nBob Ray\nyo", html);
  assert.equal(
    out,
    "Jane Doe\nProfile: https://www.linkedin.com/in/jane\nhi\nBob Ray\nProfile: https://www.linkedin.com/in/bob\nyo",
  );
});

test("unmatched name appended at end", () => {
  const out = buildPasteText("hello", a("/in/jane", "Jane Doe"));
  assert.equal(out, "hello\n\nProfile: https://www.linkedin.com/in/jane");
});

test("no profile anchors returns null", () => {
  assert.equal(buildPasteText("x", "<p>hi</p>"), null);
  assert.equal(buildPasteText("x", a("https://example.com/in/x", "X")), null);
});

test("empty html returns null", () => {
  assert.equal(buildPasteText("x", ""), null);
});

test("url already in plain is not duplicated", () => {
  const out = buildPasteText("Jane https://www.linkedin.com/in/jane", a("/in/jane", "Jane"));
  assert.equal(out, "Jane https://www.linkedin.com/in/jane");
});

test("relative and single-quoted hrefs", () => {
  const l = extractProfileLinks("<a href='/in/jane'>Jane</a>");
  assert.equal(l[0].url, "https://www.linkedin.com/in/jane");
});

test("decodes entities", () => {
  const l = extractProfileLinks(a("https://www.linkedin.com/in/jane?a=1&amp;b=2", "Jane &amp; Co"));
  assert.equal(l[0].name, "Jane & Co");
  assert.equal(l[0].url, "https://www.linkedin.com/in/jane");
});
