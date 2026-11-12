import { test, expect } from "@playwright/test";

// Read-only: mocks /api/runs, never presses Send or starts an agent.
test.use({ viewport: { width: 390, height: 844 } });

const run = {
  id: 1, agent_slug: "chief_of_staff", trigger: "chat", thread: null, parent_run_id: null, model: null, effort: null,
  prompt: "Do the thing", status: "done", summary: "All done", input_tokens: 100, output_tokens: 50, cache_read_tokens: 0,
  cache_write_tokens: 0, thinking_tokens: 0, cost_usd: 0.01, tool_calls: 1, turns: 2,
  started_at: "2026-01-01T12:00:00Z", ended_at: "2026-01-01T12:00:10Z", duration_ms: 10000,
};
const totals = { runs: 1, input_tokens: 100, output_tokens: 50, thinking_tokens: 0, tool_calls: 1, cost_usd: 0.01 };
const usage = { byAgent: [{ agent_slug: "chief_of_staff", ...totals }], byModel: [], total: totals };
const at = "2026-01-01T12:00:01Z";
const events = [
  { id: 1, agent_slug: "chief_of_staff", kind: "text", tool: null, content: `${"x".repeat(300)}\n\nSecond paragraph.\n\nThird paragraph.`, is_error: 0, at },
  { id: 2, agent_slug: "chief_of_staff", kind: "tool_call", tool: "search", content: JSON.stringify({ q: "hello" }), is_error: 0, at },
  { id: 3, agent_slug: "chief_of_staff", kind: "tool_result", tool: "search", content: "result body", is_error: 0, at },
  { id: 4, agent_slug: "chief_of_staff", kind: "delegate", tool: "full_stack_engineer", content: "brief ".repeat(100), is_error: 0, at },
];

test("agent run is fully visible and unclipped on a phone", async ({ page }) => {
  await page.route("**/api/runs**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET") return route.abort();
    const body = url.searchParams.get("id") ? { run, handoffs: [], job: null, events } : { runs: [run], today: usage, week: usage };
    await route.fulfill({ json: body });
  });

  await page.goto("/team?view=activity");
  const detail = page.getByTestId("run-detail");
  await expect(detail).toBeVisible();

  const box = await page.getByTestId("event-text").first().boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);

  const clipped = await detail.evaluate((el) => {
    const p = el.parentElement!;
    return p.scrollHeight > p.clientHeight + 1;
  });
  expect(clipped).toBe(false);

  for (const k of ["text", "tool_call", "tool_result", "delegate"]) {
    const el = page.getByTestId(`event-${k}`).first();
    await el.scrollIntoViewIfNeeded();
    await expect(el).toBeVisible();
  }

  const noHScroll = await page.evaluate(() => {
    const m = document.querySelector("main")!;
    return m.scrollWidth <= m.clientWidth;
  });
  expect(noHScroll).toBe(true);
});
