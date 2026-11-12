import { test, expect } from "./isolated-test";

// Agent-drafted emails wait in Communications → Email → Drafts. Never presses Approve & send.

test("an email draft shows in the approval queue and can be discarded without sending", async ({ page, request }) => {
  const { accounts } = await (await request.get("/api/mail-accounts")).json();
  const account = accounts?.find((a: any) => a.status === "connected")?.email;
  test.skip(!account, "no connected mail account on this server");

  const subject = `E2E draft ${Date.now()}`;
  const res = await request.post("/api/email-drafts", {
    data: { account, to: "e2e@example.com", subject, body: "Never sent.", reason: "e2e", created_by: "chief_of_staff" },
  });
  expect(res.status()).toBe(201);
  const { draft_id } = await res.json();

  await page.goto("/communications?tab=email");
  await page.getByTestId("email-drafts-toggle").click();
  const card = page.getByTestId(`email-draft-${draft_id}`);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByText("drafted by Chief")).toBeVisible();

  page.once("dialog", (d) => d.accept());
  await card.getByRole("button", { name: "Discard" }).click();
  await expect(card).toHaveCount(0, { timeout: 10_000 });
  const pending = (await (await request.get("/api/email-drafts")).json()).drafts;
  expect(pending.some((d: any) => d.id === draft_id)).toBeFalsy();
});

test("drafting from an account that isn't connected is refused", async ({ request }) => {
  const res = await request.post("/api/email-drafts", { data: { account: "nobody@example.com", to: "x@example.com", subject: "x", body: "x" } });
  expect(res.status()).toBe(400);
});
