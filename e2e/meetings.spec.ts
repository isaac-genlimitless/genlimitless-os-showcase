import { test, expect } from "./isolated-test";
import { cleanupMeetings } from "./test-cleanup";

test.afterEach(() => cleanupMeetings());

// Meeting lifecycle over the API, with no audio and no transcript: it must fail with a clear,
// actionable message instead of calling a model on nothing. Never records, never runs the agent.

test("a meeting with nothing heard fails clearly and keeps what was saved", async ({ request }) => {
  const { meeting } = await (await request.post("/api/meetings", { data: { title: "E2E empty meeting" } })).json();
  expect(meeting.status).toBe("recording");

  // An empty transcript on finish must not wipe what was saved during the call.
  await request.patch(`/api/meetings/${meeting.id}`, { data: { live_transcript: "" } });
  await request.post(`/api/meetings/${meeting.id}/finish`, { data: { live_transcript: "" } });

  await expect
    .poll(async () => (await (await request.get(`/api/meetings/${meeting.id}`)).json()).meeting.status, { timeout: 15_000 })
    .toBe("failed");
  const done = (await (await request.get(`/api/meetings/${meeting.id}`)).json()).meeting;
  expect(done.error).toMatch(/No transcript/);

  // No more audio once it's stopped.
  const late = await request.post(`/api/meetings/${meeting.id}/audio`, { data: Buffer.from([1, 2, 3]) });
  expect(late.status()).toBe(400);
});

test("the meetings list shows a recorded meeting and opens it", async ({ page, request }) => {
  const title = `E2E listed meeting ${Date.now()}`;
  const { meeting } = await (await request.post("/api/meetings", { data: { title } })).json();
  await request.post(`/api/meetings/${meeting.id}/finish`, { data: {} });
  await page.goto("/meetings");
  await page.getByRole("button", { name: new RegExp(title) }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible({ timeout: 15_000 });
});
