import type { Page } from "@playwright/test";
import { test, expect } from "./isolated-test";

// Undo button under AI replies. All network is mocked: never presses Send, never runs an agent,
// never really undoes anything.

async function mock(page: Page) {
  const posts: any[] = [];
  let undone = false;
  await page.route(
    (u) => u.pathname === "/api/chat",
    async (route) => {
      if (route.request().method() !== "GET") return route.fulfill({ status: 400, body: "{}" });
      await route.fulfill({
        json: {
          threads: [],
          running: [],
          messages: [
            { id: 10, role: "user", content: "do things" },
            { id: 11, role: "assistant", content: "Done.", undo: { state: undone ? "undone" : "available" } },
            { id: 12, role: "assistant", content: "Nothing here.", undo: { state: "none" } },
          ],
        },
      });
    },
  );
  await page.route(
    (u) => u.pathname === "/api/chat/undo",
    async (route) => {
      const req = route.request();
      if (req.method() === "POST") {
        posts.push(req.postDataJSON());
        undone = true;
        return route.fulfill({ json: { ok: true } });
      }
      await route.fulfill({
        json: {
          status: "done",
          reversible: [
            { action_id: 1, label: 'Edited Files page "Plan"' },
            { action_id: 2, label: 'Created task "Call Bob"', conflict: { label: "later reply" } },
          ],
          cannot: [{ label: "Approval request #9", reason: "already decided" }],
        },
      });
    },
  );
  return posts;
}

async function run(page: Page, scope: ReturnType<Page["locator"]>, posts: any[]) {
  await expect(scope.getByTestId("undo-turn")).toHaveCount(1, { timeout: 15_000 });
  await expect(scope.getByText("Nothing to undo")).toBeVisible();

  await scope.getByTestId("undo-turn").click();
  const dlg = page.getByTestId("undo-dialog");
  await expect(dlg).toBeVisible();
  await expect(dlg.getByText('Edited Files page "Plan"')).toBeVisible();
  await expect(dlg.getByText('Created task "Call Bob"')).toBeVisible();
  await expect(dlg.getByText(/Changed again later by .later reply./)).toBeVisible();
  await expect(dlg.getByRole("checkbox")).not.toBeChecked();
  await expect(dlg.getByText("These can't be undone:")).toBeVisible();
  await expect(dlg.getByText(/Approval request #9/)).toBeVisible();

  await dlg.getByRole("button", { name: "Cancel" }).click();
  await expect(dlg).toHaveCount(0);
  expect(posts.length).toBe(0);

  await scope.getByTestId("undo-turn").click();
  await page.getByTestId("undo-confirm").click();
  await expect(dlg).toHaveCount(0);
  expect(posts).toEqual([{ chat_id: 11, action: "undo", overwrite: [] }]);
  await expect(scope.getByText("Undone", { exact: true })).toBeVisible();
  await expect(scope.getByTestId("redo-turn")).toBeVisible();
}

test("main chat: undo button, dialog, cancel, confirm, undone state", async ({ page }) => {
  const posts = await mock(page);
  await page.goto("/");
  await run(page, page.locator("body"), posts);
});

test("docked side chat: undo button, dialog, cancel, confirm, undone state", async ({ page }) => {
  const posts = await mock(page);
  await page.goto("/tasks");
  await page.getByTestId("chat-dock-open").click();
  await run(page, page.getByTestId("chat-dock"), posts);
});
