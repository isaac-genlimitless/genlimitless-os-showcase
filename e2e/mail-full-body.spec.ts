import { test, expect } from "@playwright/test";
import { bestPlainText, capBody, extractLinkedInMessage } from "../src/lib/email-text";
import { listMessagesPage } from "../src/lib/gmail";

// Pure-function / mocked-fetch tests: no network, nothing sent, no agent triggered.

test("short plain stub + long HTML body returns the HTML text", () => {
  const long = "Hello Owner, this is the real message text. ".repeat(20);
  const out = bestPlainText("View message", `<html><body><p>${long}</p></body></html>`);
  expect(out).toContain("real message text");
  expect(out.length).toBeGreaterThan(500);
});

test("plain text stays when HTML is not much longer", () => {
  expect(bestPlainText("Short note", "<p>Short note</p>")).toBe("Short note");
});

test("10,000-char body is not cut; over 40,000 is flagged truncated", () => {
  const a = capBody("x".repeat(10_000));
  expect(a.truncated).toBe(false);
  expect(a.text.length).toBe(10_000);
  const b = capBody("y".repeat(40_001));
  expect(b.truncated).toBe(true);
  expect(b.chars).toBe(40_001);
  expect(b.text).toContain("TRUNCATED");
});

test("extractLinkedInMessage: real message vs teaser", () => {
  const from = '"Bruce Lee Lang" <messaging-digest-noreply@linkedin.com>';
  const real = [
    "Bruce Lee Lang",
    "Hi Owner, thanks for connecting. Can we talk about the partnership next week?",
    "View message",
    "Unsubscribe",
    "You are receiving LinkedIn notification emails.",
    "LinkedIn Corporation, 2029 Stierlin Court",
  ].join("\n");
  const r = extractLinkedInMessage(real, from)!;
  expect(r.teaser_only).toBe(false);
  expect(r.message).toContain("partnership next week");
  expect(r.message).not.toContain("Unsubscribe");

  const teaser = extractLinkedInMessage("Bruce Lee Lang\nView message\nUnsubscribe", from)!;
  expect(teaser.teaser_only).toBe(true);

  expect(extractLinkedInMessage("anything", "bob@example.com")).toBeNull();
});

test("listMessagesPage follows nextPageToken across two pages", async () => {
  process.env.GOOGLE_CLIENT_ID = "id";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  const realFetch = globalThis.fetch;
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    if (u.includes("oauth2.googleapis.com")) return json({ access_token: "t" });
    if (/\/messages\/m\d/.test(u)) {
      const id = u.match(/\/messages\/(m\d)/)![1];
      return json({ id, threadId: "t" + id, snippet: "s", labelIds: ["UNREAD", "CATEGORY_SOCIAL"], payload: { headers: [] } });
    }
    if (u.includes("pageToken=p2")) return json({ messages: [{ id: "m3" }, { id: "m4" }] });
    return json({ messages: [{ id: "m1" }, { id: "m2" }], nextPageToken: "p2" });
  }) as typeof fetch;
  try {
    const page = await listMessagesPage({ refresh_token: "r" } as any, { limit: 4, q: "is:unread" });
    expect(page.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(page.messages[0].category).toBe("social");
    expect(page.messages[0].unread).toBe(true);
    expect(page.messages[0].body_source).toBe("snippet");
  } finally {
    globalThis.fetch = realFetch;
  }
});
