import { test, expect } from "@playwright/test";
import { checkPublicUrlShape, assertPublicHost, readWebPage, greenhouseApiUrl, formatGreenhouse, decodeCfEmails, exposeMailtos } from "../src/lib/web-page";
import { readWebPageRendered } from "../src/lib/web-page-browser";
import { createServer } from "node:http";
import { permsFor, looksPrivateQuery } from "../src/lib/agents/runtime";
import { assignableCatalog, toolNames } from "../src/lib/agents/tools";
import { getAgent } from "../src/lib/agents/registry";

// Agents may read any public page, but the URL can't carry Owner's data out and the host can't be
// the OS itself or anything on the network. Pure: no third-party network, never sends or triggers an agent.

test("exposeMailtos: shows the address behind mailto links, no duplicates, bad input untouched", () => {
  expect(exposeMailtos('<a href="mailto:contact@example.org">Pat Example</a>')).toContain("Pat Example</a> (contact@example.org)");
  const already = '<a href="mailto:contact@example.org">contact@example.org</a>';
  expect(exposeMailtos(already)).toBe(already);
  const bad = '<a href="mailto:not an email">Mail us</a>';
  expect(exposeMailtos(bad)).toBe(bad);
  expect(exposeMailtos('<footer><a href="mailto:a@x.org">Mail</a></footer>')).toContain("Contact emails on page: a@x.org");
});

test("decodeCfEmails: Cloudflare-protected addresses are shown; bad input is left alone", () => {
  const enc = (s: string, key: number) =>
    key.toString(16).padStart(2, "0") + [...s].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, "0")).join("");
  const hex = enc("info@example.com", 0x2a);
  expect(decodeCfEmails(`<a class="__cf_email__" data-cfemail="${hex}">[email protected]</a>`)).toBe("info@example.com");
  expect(decodeCfEmails(`<a href="/cdn-cgi/l/email-protection#${hex}">[email protected]</a>`)).toBe("info@example.com");
  const bad = '<span class="__cf_email__" data-cfemail="zz">[email protected]</span>';
  expect(decodeCfEmails(bad)).toBe(bad);
  const notEmail = `<span data-cfemail="${enc("hello world", 0x2a)}">[email protected]</span>`;
  expect(decodeCfEmails(notEmail)).toBe(notEmail);
});

test("URL shape: real page links pass, data-carrying ones don't", () => {
  expect(checkPublicUrlShape(new URL("https://example.com/jobs/123?id=9"))).toBeNull();
  expect(checkPublicUrlShape(new URL("https://evil.example/?d=owner@example.com"))).not.toBeNull();
  expect(checkPublicUrlShape(new URL("https://evil.example/?d=aGVsbG8gd29ybGQgdGhpcyBpcyBzZWNyZXQgZGF0YQ0123456789"))).not.toBeNull();
  expect(checkPublicUrlShape(new URL("https://user:pw@example.com/"))).not.toBeNull();
  expect(checkPublicUrlShape(new URL("https://example.com:8080/"))).not.toBeNull();
  expect(checkPublicUrlShape(new URL(`https://example.com/a?${"q=1&".repeat(80)}`))).not.toBeNull();
});

test("URL shape: multi-segment paths and slugs pass, single blobs and long queries don't", () => {
  for (const u of [
    "https://boards.greenhouse.io/getbuilt/jobs/4400066005",
    "https://boards-api.greenhouse.io/v1/boards/getbuilt/jobs",
    "https://builtin.com/job/senior-software-engineer-platform/123456",
  ])
    expect(checkPublicUrlShape(new URL(u)), u).toBeNull();
  expect(checkPublicUrlShape(new URL("https://evil.example/aGVsbG8gd29ybGQgdGhpcyBpcyBzZWNyZXQ"))).not.toBeNull();
  expect(checkPublicUrlShape(new URL("https://evil.example/?d=aGVsbG8gd29ybGQgdGhpcyBpcyBzZWNyZXQgZGF0YQ0123456789"))).not.toBeNull();
});

test("greenhouseApiUrl maps board and job URLs to the public API only", () => {
  const api = "https://boards-api.greenhouse.io/v1/boards/getbuilt/jobs";
  expect(greenhouseApiUrl(new URL("https://boards.greenhouse.io/getbuilt"))).toBe(api);
  expect(greenhouseApiUrl(new URL("https://job-boards.greenhouse.io/getbuilt/jobs/4400066005"))).toBe(`${api}/4400066005`);
  expect(greenhouseApiUrl(new URL("https://boards-api.greenhouse.io/v1/boards/getbuilt/jobs/4400066005"))).toBe(`${api}/4400066005`);
  expect(greenhouseApiUrl(new URL("https://example.com/getbuilt"))).toBeNull();
  expect(greenhouseApiUrl(new URL("https://boards.greenhouse.io/bad%40board"))).toBeNull();
  expect(greenhouseApiUrl(new URL(`https://boards.greenhouse.io/${"a".repeat(41)}`))).toBeNull();
  expect(greenhouseApiUrl(new URL("https://boards.greenhouse.io/getbuilt/jobs/abc"))).toBeNull();
});

test("formatGreenhouse gives readable text from escaped HTML", () => {
  const job = formatGreenhouse({
    id: 1,
    title: "Senior Engineer",
    location: { name: "Remote" },
    departments: [{ name: "Engineering" }],
    offices: [{ name: "Austin" }],
    updated_at: "2026-09-01",
    absolute_url: "https://boards.greenhouse.io/getbuilt/jobs/1",
    content: "&lt;p&gt;Build &lt;strong&gt;great&lt;/strong&gt; things&lt;/p&gt;",
  });
  expect(job.title).toBe("Senior Engineer");
  expect(job.text).toContain("Build");
  expect(job.text).toContain("great");
  expect(job.text).not.toContain("&lt;");
  expect(job.text).not.toContain("<p>");
  const board = formatGreenhouse({ jobs: [{ id: 2, title: "Designer", location: { name: "NYC" }, absolute_url: "https://x.example/2" }] });
  expect(board.text).toBe("2 | Designer | NYC | https://x.example/2");
});

test("read_web_page explains bot-blocked pages", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("denied", { status: 403 })) as typeof fetch;
  try {
    await expect(readWebPage({ url: "https://93.184.216.34/jobs/1" })).rejects.toThrow(/blocked automated reading/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("live: Built's Greenhouse job reads in full (LIVE_WEB=1 only)", async () => {
  test.skip(process.env.LIVE_WEB !== "1", "set LIVE_WEB=1 to hit the real Greenhouse API");
  const r = await readWebPage({ url: "https://boards.greenhouse.io/getbuilt/jobs/4400066005" });
  expect(r.title).toBeTruthy();
  expect(r.total_chars).toBeGreaterThan(500);
});

test("hosts that are local, private or numeric are refused", async () => {
  for (const h of ["localhost", "127.0.0.1", "2130706433", "0x7f000001", "[::1]", "10.0.0.5", "169.254.169.254", "100.64.0.1", "::ffff:127.0.0.1"])
    await expect(assertPublicHost(h), h).rejects.toThrow();
});

test("read_web_page refuses bad URLs before any fetch", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error("fetch must not be called");
  }) as typeof fetch;
  try {
    await expect(readWebPage({ url: "https://evil.example/?d=owner@example.com" })).rejects.toThrow(/email/i);
    await expect(readWebPage({ url: "http://localhost:3100/api/x" })).rejects.toThrow(/local or private/i);
    expect(calls).toBe(0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("tool access: CoS can search; read_web_page is common to all", () => {
  const cos = getAgent("chief_of_staff");
  expect(cos).toBeTruthy();
  expect(permsFor(cos!).builtins.has("WebSearch")).toBe(true);
  const names = assignableCatalog().map((t) => t.name);
  expect(names).toContain("WebSearch");
  expect(names).not.toContain("read_web_page");
  expect(toolNames("common")).toContain("read_web_page");
});

test("rendered reader: refuses private and over-shaped URLs before launching a browser", async () => {
  await expect(readWebPageRendered({ url: "http://localhost:3100/api/x" })).rejects.toThrow(/local or private/i);
  await expect(readWebPageRendered({ url: "http://169.254.169.254/latest" })).rejects.toThrow(/local or private/i);
  await expect(readWebPageRendered({ url: "https://evil.example/?d=owner@example.com" })).rejects.toThrow(/email/i);
});

test("rendered reader: reads script-built pages and aborts private sub-requests", async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url || "");
    res.setHeader("content-type", "text/html");
    res.end(
      `<html><head><title>Shell</title></head><body><div id="a"></div><script>
      document.getElementById("a").textContent = "Built by script: " + "senior engineer role ".repeat(5);
      fetch("http://169.254.169.254/latest/meta-data").catch(function(){});
      fetch("http://127.0.0.1:3100/api/x").catch(function(){});
      </script></body></html>`,
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const blockedHosts: string[] = [];
  // Test-only guard: the local server ("localhost") is allowed, everything else must be refused.
  const hostGuard = async (h: string) => {
    if (h === "localhost") return;
    blockedHosts.push(h);
    throw new Error("refused " + h);
  };
  const url = `http://localhost:${port}/jobs`;
  try {
    const plain = await readWebPage({ url }).catch((e) => e as Error);
    expect(plain instanceof Error || /Very little text/.test((plain as { note?: string }).note || "")).toBe(true);
    let r;
    try {
      r = await readWebPageRendered({ url, hostGuard });
    } catch (e) {
      if (/no browser installed/.test(String(e))) test.skip(true, "Chromium isn't installed on this machine");
      throw e;
    }
    expect(r.text).toContain("Built by script");
    expect(blockedHosts).toEqual(expect.arrayContaining(["169.254.169.254", "127.0.0.1"]));
  } finally {
    server.close();
  }
});

test("read_web_page tool: render is optional and the default path still exists", () => {
  expect(toolNames("common")).toContain("read_web_page");
});

test("search query guard flags private data, passes public topics", () => {
  expect(looksPrivateQuery("owner@example.com school list")).toBe(true);
  expect(looksPrivateQuery("9f86d081884c7d659a2feaa0c55ad015")).toBe(true);
  expect(looksPrivateQuery("online charter school Texas enrollment director")).toBe(false);
});
