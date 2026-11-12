// Unit tests for the LinkedIn guest reader. No network, never sends or triggers an agent.
import test from "node:test";
import assert from "node:assert/strict";
import { linkedinJobApiUrl, parseLinkedinGuest, describeFetchError, isBotWalledHost, readWebPage } from "./web-page";

test("isBotWalledHost matches only Wellfound/angel.co hosts", () => {
  for (const h of ["wellfound.com", "www.wellfound.com", "angel.co"]) assert.equal(isBotWalledHost(h), true);
  for (const h of ["example.com", "notwellfound.com"]) assert.equal(isBotWalledHost(h), false);
});

test("403 handling: normal host keeps old text, wellfound gets alternatives (mocked fetch)", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response("no", { status: 403 })) as typeof fetch;
  try {
    await assert.rejects(readWebPage({ url: "https://example.com/jobs" }), /blocked automated reading/);
    await assert.rejects(readWebPage({ url: "https://wellfound.com/company/x/jobs" }), /Wellfound blocks automated reading from this server/);
  } finally {
    globalThis.fetch = real;
  }
});

test("describeFetchError maps causes to plain messages (no network)", () => {
  assert.match(describeFetchError({ cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } }, "x.tn.gov"), /certificate problem/);
  assert.match(describeFetchError({ cause: { code: "ECONNRESET" } }, "x.tn.gov"), /refused or didn't answer/);
});

import { jobBoardApiUrl, readJobBoardApi, unavailableMessage } from "./web-page-api";

function mockFetch(body: unknown, seen: string[]) {
  globalThis.fetch = (async (u: string) => {
    seen.push(String(u));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

test("job board API: Ashby, Lever, Greenhouse URL shapes (mocked fetch)", async () => {
  const real = globalThis.fetch;
  try {
    const seen: string[] = [];
    mockFetch({ jobs: [{ id: "abc-1", title: "Eng", descriptionPlain: "Build things" }] }, seen);
    const a = await readJobBoardApi(new URL("https://jobs.ashbyhq.com/acme/abc-1"), 0);
    assert.equal(a?.title, "Eng");
    assert.equal(a?.text, "Title: Eng\n\nBuild things");
    assert.equal(seen[0], "https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true");

    mockFetch({ text: "Designer", descriptionPlain: "Design" }, seen);
    const l = await readJobBoardApi(new URL("https://jobs.lever.co/acme/1234-ab"), 0);
    assert.equal(l?.title, "Designer");
    assert.equal(seen[1], "https://api.lever.co/v0/postings/acme/1234-ab");

    mockFetch({ title: "PM", content: "&lt;p&gt;Lead&lt;/p&gt;" }, seen);
    const g = await readJobBoardApi(new URL("https://job-boards.greenhouse.io/acme/jobs/99"), 0);
    assert.equal(g?.title, "PM");
    assert.match(g?.text || "", /Lead/);
    assert.equal(seen[2], "https://boards-api.greenhouse.io/v1/boards/acme/jobs/99");
  } finally {
    globalThis.fetch = real;
  }
});

test("job board API rejects bad org/id and other hosts", () => {
  assert.equal(jobBoardApiUrl(new URL("https://jobs.lever.co/ac%2Fme/12")), null);
  assert.equal(jobBoardApiUrl(new URL("https://jobs.ashbyhq.com/acme/a%20b")), null);
  assert.equal(jobBoardApiUrl(new URL("https://boards.greenhouse.io/acme/jobs/9$")), null);
  assert.equal(jobBoardApiUrl(new URL("https://evil.example.com/acme/12")), null);
});

test("launch failure message includes the underlying reason", () => {
  const msg = unavailableMessage("Rendered reading isn't available.", new Error("PDF engine unavailable (default: missing libs)"));
  assert.match(msg, /isn't available/);
  assert.match(msg, /missing libs/);
});

const GUEST ="https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4465950460";

test("linkedinJobApiUrl maps job URLs to the guest endpoint", () => {
  for (const u of [
    "https://www.linkedin.com/jobs/view/4465950460/",
    "https://www.linkedin.com/jobs/view/senior-engineer-at-acme-4465950460",
    "https://www.linkedin.com/jobs/search/?currentJobId=4465950460",
    "https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4465950460",
  ]) {
    assert.equal(linkedinJobApiUrl(new URL(u)), GUEST, u);
  }
});

test("linkedinJobApiUrl returns null for other pages and hosts", () => {
  for (const u of [
    "https://www.linkedin.com/in/someone",
    "https://www.linkedin.com/company/x",
    "https://example.com/jobs/view/4465950460/",
    "https://evil-linkedin.com/jobs/view/4465950460/",
    "https://linkedin.com.evil.com/jobs/view/4465950460/",
  ]) {
    assert.equal(linkedinJobApiUrl(new URL(u)), null, u);
  }
});

test("parseLinkedinGuest extracts title, company, location, description", () => {
  const html = `<html><body><div class="top-card-layout">
    <h2 class="top-card-layout__title">Senior Engineer</h2>
    <a class="topcard__org-name-link" href="https://x">Acme</a>
    <span class="topcard__flavor topcard__flavor--bullet">Remote</span></div>
    <div class="show-more-less-html__markup"><p>Build <b>things</b>.</p><img src="a.png"></div></body></html>`;
  const p = parseLinkedinGuest(html);
  assert.ok(p);
  assert.equal(p.title, "Senior Engineer");
  assert.match(p.text, /Company: Acme/);
  assert.match(p.text, /Location: Remote/);
  assert.match(p.text, /Build \*?things\*?\./i);
  assert.equal(parseLinkedinGuest("<html><body>Sign in</body></html>"), null);
});

import { isJobBoardFeed } from "./web-page";

const AID = "123e4567-e89b-12d3-a456-426614174000";
const feedBase = "https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true";

test("isJobBoardFeed accepts a uuid jobId and rejects free text", () => {
  assert.equal(isJobBoardFeed(new URL(`${feedBase}&jobId=${AID}`)), true);
  assert.equal(isJobBoardFeed(new URL(`${feedBase}&jobId=abc`)), false);
  assert.equal(isJobBoardFeed(new URL(`${feedBase}&jobId=${"a".repeat(60)}`)), false);
});

test("readWebPage with jobId returns only that posting, with a header (mocked fetch)", async () => {
  const real = globalThis.fetch;
  try {
    const filler = "x".repeat(100_000);
    const feed = {
      jobs: [
        { id: "11111111-1111-1111-1111-111111111111", title: "Other", descriptionPlain: filler },
        {
          id: AID,
          title: "Scout",
          location: "Remote",
          secondaryLocations: [{ location: "Austin" }],
          team: "Ops",
          publishedAt: "2026-01-02T00:00:00Z",
          compensation: { scrapeableCompensationSalarySummary: "$100K - $120K" },
          applyUrl: "https://jobs.ashbyhq.com/acme/apply",
          descriptionPlain: "Find roles",
        },
        { id: "22222222-2222-2222-2222-222222222222", title: "Third", descriptionPlain: filler },
      ],
    };
    mockFetch(feed, []);
    const r = await readWebPage({ url: `${feedBase}&jobId=${AID}` });
    assert.match(r.text, /Find roles/);
    assert.doesNotMatch(r.text, /xxxx/);
    assert.ok(r.total_chars < 1000);
    assert.match(r.text, /Compensation: \$100K - \$120K/);
    assert.match(r.text, /Location: Remote; Austin/);

    await assert.rejects(readWebPage({ url: `${feedBase}&jobId=99999999-9999-9999-9999-999999999999` }), /Job not found in Ashby board/);
  } finally {
    globalThis.fetch = real;
  }
});
