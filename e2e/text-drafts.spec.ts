import { test, expect } from "./isolated-test";

// The text-draft approval queue (review cards in the Chief of Staff chat). Every test here creates
// drafts directly through the API to avoid triggering the agent, and NEVER calls the
// "approve" action — that's the only path that reaches trackedIMessage/AppleScript, and
// running it for real here would actually send a text.
//
// The dev server's sqlite db isn't reset between runs, so fixture text includes a run-unique
// tag to avoid matching leftover rows from a previous run.
const tag = Date.now();

test("creating a text draft leaves it pending_approval and never touches imessage_sends", async ({ request }) => {
  const create = await request.post("/api/text-drafts", {
    data: { to: "+15555550123", text: "Can I come by Thursday at 6?", reason: "e2e fixture" },
  });
  expect(create.ok(), await create.text()).toBeTruthy();
  const created = await create.json();
  expect(created.status).toBe("pending_approval");

  const list = await (await request.get("/api/text-drafts")).json();
  const draft = list.drafts.find((d: any) => d.id === created.draft_id);
  expect(draft).toBeTruthy();
  expect(draft.status).toBe("pending_approval");
  // send_id is only ever set by the approve/auto-send path, which this test never calls.
  expect(draft.send_id).toBeNull();
});

test("draft creation requires text and a recipient", async ({ request }) => {
  const res = await request.post("/api/text-drafts", { data: { text: "no recipient given" } });
  expect(res.status()).toBe(400);
});

test("editing a pending draft updates its text without sending", async ({ request }) => {
  const create = await request.post("/api/text-drafts", {
    data: { to: "+15555550124", text: "Original text", reason: "e2e fixture" },
  });
  const { draft_id } = await create.json();

  const edit = await request.patch("/api/text-drafts", {
    data: { draft_id, action: "edit", edited_text: "Edited text" },
  });
  expect(edit.ok()).toBeTruthy();

  const list = await (await request.get("/api/text-drafts")).json();
  const draft = list.drafts.find((d: any) => d.id === draft_id);
  expect(draft.text).toBe("Edited text");
  expect(draft.status).toBe("pending_approval");
  expect(draft.send_id).toBeNull();
});

test("rejecting a draft cancels it and it never reaches imessage_sends", async ({ request }) => {
  const create = await request.post("/api/text-drafts", {
    data: { to: "+15555550125", text: "Reject me", reason: "e2e fixture" },
  });
  const { draft_id } = await create.json();

  const reject = await request.patch("/api/text-drafts", { data: { draft_id, action: "reject" } });
  expect(reject.ok()).toBeTruthy();

  const list = await (await request.get("/api/text-drafts")).json();
  const draft = list.drafts.find((d: any) => d.id === draft_id);
  expect(draft.status).toBe("cancelled");
  expect(draft.send_id).toBeNull();

  // A rejected draft can't be edited or approved after the fact.
  const editAfterReject = await request.patch("/api/text-drafts", {
    data: { draft_id, action: "edit", edited_text: "too late" },
  });
  expect(editAfterReject.ok()).toBeFalsy();
});

test("a new text draft shows up in the chat as a review card with Edit/Approve/Reject", async ({ page, request }) => {
  const text = `Visible in the UI ${tag}`;
  await request.post("/api/text-drafts", {
    data: { to: "+15555550126", text, reason: "e2e fixture" },
  });
  await page.goto("/");
  const card = page.getByTestId("text-draft-card").filter({ has: page.locator(`textarea:text-is("${text}")`) });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByTestId("text-draft-save")).toBeVisible();
  await expect(card.getByTestId("text-draft-approve")).toBeVisible();
  await expect(card.getByTestId("text-draft-reject")).toBeVisible();
});

test("rejecting from the chat card cancels the draft without sending", async ({ page, request }) => {
  const text = `Reject me from the UI ${tag}`;
  const create = await request.post("/api/text-drafts", {
    data: { to: "+15555550127", text, reason: "e2e fixture" },
  });
  const { draft_id } = await create.json();

  await page.goto("/");
  const card = page.getByTestId("text-draft-card").filter({ has: page.locator(`textarea:text-is("${text}")`) });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByTestId("text-draft-reject").click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("text-draft-card").filter({ hasText: "rejected" }).filter({ hasText: text })).toBeVisible();

  const list = await (await request.get("/api/text-drafts")).json();
  const draft = list.drafts.find((d: any) => d.id === draft_id);
  expect(draft.status).toBe("cancelled");
  expect(draft.send_id).toBeNull();
});

test("Communications no longer has Individual or Text Drafts tabs", async ({ page }) => {
  await page.goto("/communications");
  await expect(page.getByRole("button", { name: "Email" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Individual" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Text Drafts" })).toHaveCount(0);
});

test("auto-send allowlist can be added to and removed from via the API", async ({ request }) => {
  const add = await request.post("/api/text-drafts/allowlist", {
    data: { handle: "+15555550100", label: "Test contact" },
  });
  expect(add.ok()).toBeTruthy();

  const list = await (await request.get("/api/text-drafts/allowlist")).json();
  const entry = list.allowlist.find((a: any) => a.handle === "+15555550100");
  expect(entry).toBeTruthy();
  expect(entry.label).toBe("Test contact");

  const remove = await request.delete(`/api/text-drafts/allowlist?id=${entry.id}`);
  expect(remove.ok()).toBeTruthy();
  const after = await (await request.get("/api/text-drafts/allowlist")).json();
  expect(after.allowlist.find((a: any) => a.id === entry.id)).toBeUndefined();
});
