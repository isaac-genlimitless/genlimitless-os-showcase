import { test, expect } from "./isolated-test";
import fs from "fs";
import path from "path";
import { openTestDb, testFilesDir } from "./db-handle";
import { cleanupFilesPages } from "./test-cleanup";

// Regression for #24 (Files half): proves cleanupFilesPages() actually leaves zero "E2E "-
// prefixed rows in the Files workspace (the `docs` table) and zero orphaned bytes under
// testFilesDir() after a run - This is what stops the ~20 junk "E2E ..." pages/
// evil.html/notes.txt from ever accumulating in Owner's real Files again.

test("cleanupFilesPages leaves zero E2E rows and zero orphaned uploaded bytes", async ({ request }) => {
  const stamp = Date.now();
  const pageTitle = `E2E Regression Page ${stamp}`;
  const folderTitle = `E2E Regression Folder ${stamp}`;
  const childTitle = `E2E Regression Child ${stamp}`;
  const uploadName = `E2E Regression notes ${stamp}.txt`;

  const page = await (await request.post("/api/files", { data: { title: pageTitle, body: "Regression content." } })).json();
  expect(page.page?.id).toBeTruthy();

  const folder = await (await request.post("/api/files", { data: { title: folderTitle, kind: "folder" } })).json();
  expect(folder.page?.id).toBeTruthy();

  const child = await (
    await request.post("/api/files", { data: { title: childTitle, parent_id: folder.page.id, body: "nested" } })
  ).json();
  expect(child.page?.id).toBeTruthy();

  const upload = await request.post("/api/files", {
    multipart: { files: { name: uploadName, mimeType: "text/plain", buffer: Buffer.from("regression bytes") } },
  });
  const { pages: uploadedPages } = await upload.json();
  const uploadedFilePath: string = uploadedPages[0].file_path;
  expect(uploadedFilePath).toBeTruthy();
  expect(fs.existsSync(path.join(testFilesDir(), uploadedFilePath))).toBe(true);

  cleanupFilesPages();

  const db = openTestDb();
  try {
    const remaining = db.prepare(`SELECT COUNT(*) AS n FROM docs WHERE title LIKE 'E2E %'`).get() as { n: number };
    expect(remaining.n).toBe(0);
  } finally {
    db.close();
  }

  expect(fs.existsSync(path.join(testFilesDir(), uploadedFilePath))).toBe(false);
});
