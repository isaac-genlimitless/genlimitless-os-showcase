// Fixture tests for the public LinkedIn reader. No network, never sends or triggers an agent.
import test from "node:test";
import assert from "node:assert/strict";
import { isLinkedInSocialUrl, rebuildLinkedInUrl, parseLinkedInPublic, readLinkedInPublic, type SocialDeps } from "./web-page-social";

const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
const page = (head: string) => `<html><head>${head}</head><body></body></html>`;

const PERSON = page(
  `<meta property="og:title" content="Jane Doe - Head of Talent - Acme | LinkedIn">` +
    ld({ "@context": "https://schema.org", "@graph": [{ "@type": "Person", name: "Jane Doe", jobTitle: ["Head of Talent"], worksFor: [{ "@type": "Organization", name: "Acme" }], description: "Hiring." }] }),
);
const COMPANY = page(ld({ "@type": "Organization", name: "Acme", description: "We build.", numberOfEmployees: { value: 120 } }));
const POST = page(`<meta property="og:title" content="Jane on LinkedIn: We are hiring"><meta property="og:description" content="We are hiring an engineer &amp; more">`);
const AUTHWALL = page(`<meta property="og:title" content="Sign Up | LinkedIn">`);

function deps(fetchImpl: () => Response, counters = { fetch: 0, render: 0, hosts: [] as string[] }) {
  const d: SocialDeps = {
    assertPublicHost: async (h) => {
      counters.hosts.push(h);
    },
    fetchPage: async () => {
      counters.fetch++;
      return fetchImpl();
    },
    headers: {},
    paged: (text, offset, url, title, note) => ({ text: text.slice(offset), url, title, note }),
    render: async () => {
      counters.render++;
      throw new Error("no browser");
    },
  };
  return { d, counters };
}

test("URL shape: accepts people/company/post, rejects traversal and other hosts", () => {
  for (const u of ["https://www.linkedin.com/in/jane-doe", "https://uk.linkedin.com/company/acme/", "https://linkedin.com/posts/jane_x-123", "https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678", "https://www.linkedin.com/pulse/some-article"])
    assert.equal(isLinkedInSocialUrl(new URL(u)), true, u);
  for (const u of ["https://www.linkedin.com/in/../admin", "https://evil.com/in/jane", "https://linkedin.com.evil.com/in/jane", "https://www.linkedin.com/jobs/view/123", "https://www.linkedin.com/feed/update/urn:li:activity:abc", "https://www.linkedin.com/in/"])
    assert.equal(isLinkedInSocialUrl(new URL(u)), false, u);
  assert.equal(rebuildLinkedInUrl(new URL("http://uk.linkedin.com/in/jane?x=1#y")), "https://www.linkedin.com/in/jane");
});

test("parses person JSON-LD, company JSON-LD, post og-only; authwall yields null", () => {
  const p = parseLinkedInPublic(PERSON)!;
  assert.match(p.text, /Name: Jane Doe/);
  assert.match(p.text, /Job title: Head of Talent/);
  assert.match(p.text, /Works for: Acme/);
  assert.match(parseLinkedInPublic(COMPANY)!.text, /Employees: 120/);
  const post = parseLinkedInPublic(POST)!;
  assert.match(post.text, /We are hiring an engineer & more/);
  assert.equal(parseLinkedInPublic(AUTHWALL), null);
});

test("readLinkedInPublic returns paged content with slug-collision note and guards each hop", async () => {
  const { d, counters } = deps(() => new Response(POST, { status: 200 }));
  const r = (await readLinkedInPublic(new URL("https://www.linkedin.com/company/built"), 0, d)) as { note: string };
  assert.match(r.note, /slugs collide/);
  assert.match(r.note, /no login/);
  assert.deepEqual(counters.hosts, ["www.linkedin.com"]);
  const off = (await readLinkedInPublic(new URL("https://www.linkedin.com/in/jane"), 5, d)) as { text: string };
  assert.ok(off.text.length > 0);
});

test("redirect to authwall or off-linkedin is treated as blocked and checked once by the renderer", async () => {
  const { d, counters } = deps(() => new Response(null, { status: 302, headers: { location: "https://www.linkedin.com/authwall?x=1" } }));
  await assert.rejects(readLinkedInPublic(new URL("https://www.linkedin.com/in/jane"), 0, d), /Ask Owner to paste/);
  assert.equal(counters.fetch, 1);
  assert.equal(counters.render, 1);
});

test("HTTP 999 triggers exactly one rendered retry and no more", async () => {
  const { d, counters } = deps(() => new Response("", { status: 999 }));
  await assert.rejects(readLinkedInPublic(new URL("https://www.linkedin.com/in/jane"), 0, d), /tried: a plain public request and one headless-browser read/);
  assert.equal(counters.fetch, 1);
  assert.equal(counters.render, 1);
});

test("authwall HTML with 200 falls to the single rendered retry", async () => {
  const { d, counters } = deps(() => new Response(AUTHWALL, { status: 200 }));
  await assert.rejects(readLinkedInPublic(new URL("https://www.linkedin.com/in/jane"), 0, d), /Ask Owner to paste/);
  assert.equal(counters.render, 1);
});

test("private host guard rejection propagates and nothing is fetched", async () => {
  const { d, counters } = deps(() => new Response("x"));
  d.assertPublicHost = async () => {
    throw new Error("private address");
  };
  await assert.rejects(readLinkedInPublic(new URL("https://www.linkedin.com/in/jane"), 0, d), /private address/);
  assert.equal(counters.fetch, 0);
});

test("non-linkedin URL is refused", async () => {
  const { d } = deps(() => new Response("x"));
  await assert.rejects(readLinkedInPublic(new URL("https://evil.com/in/jane"), 0, d), /Not a public LinkedIn/);
});
