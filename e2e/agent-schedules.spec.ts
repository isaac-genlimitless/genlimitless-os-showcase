import { test, expect } from "./isolated-test";
import { describeSpec, dueOccurrence, lastOccurrence, nextOccurrence } from "../src/lib/agent-schedules-core";

const spec = { dow: 1, hour: 5, minute: 0 };

test("agent schedule core: occurrences, catch-up, DST", () => {
  const now = new Date("2026-10-24T15:00:00Z");
  expect(lastOccurrence(spec, now)!.key).toBe("2026-10-19");
  expect(nextOccurrence(spec, now)!.at.toISOString()).toBe("2026-10-26T10:00:00.000Z");
  expect(lastOccurrence(spec, new Date("2026-11-02T12:00:00Z"))!.at.toISOString()).toBe("2026-11-02T11:00:00.000Z");
  expect(dueOccurrence(spec, now, new Date("2026-10-23T00:00:00Z"), null)).toBeNull();
  expect(dueOccurrence(spec, now, new Date("2026-10-10T00:00:00Z"), null)!.key).toBe("2026-10-19");
  expect(dueOccurrence(spec, now, new Date("2026-10-10T00:00:00Z"), "2026-10-19")).toBeNull();
  expect(describeSpec(spec)).toBe("Mondays at 5:00 AM Central");
});

test("settings shows the agent schedules card", async ({ page }) => {
  await page.route("**/api/agent-schedules", (route) =>
    route.fulfill({
      json: {
        schedules: [
          {
            id: 1,
            name: "dream_job_scout_weekly",
            agent_slug: "dream_job_scout",
            task: "Run the weekly research scout and report the results in chat.",
            enabled: 1,
            description: "Mondays at 5:00 AM Central",
            nextRunLabel: "Mon, Oct 26, 5:00 AM CDT",
            agentFound: true,
          },
        ],
      },
    })
  );
  await page.goto("/settings");
  await expect(page.getByTestId("agent-schedules-card")).toBeVisible();
  const row = page.getByTestId("agent-schedule-row");
  await expect(row).toContainText("dream_job_scout");
  await expect(row).toContainText("Mondays at 5:00 AM Central");
});
