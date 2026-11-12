import { test, expect } from "./isolated-test";
import fs from "fs";
import os from "os";
import path from "path";

// Stubs `gh` with a fake executable on PATH. Never sends anything or runs an agent.
test("PR notice is posted even when auto-opening Claude PRs fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fakegh-"));
  const script = `#!/bin/sh
case "$*" in
  *"pr list --state open"*) echo '[{"number":987654,"title":"Fake unseen PR","url":"https://example.com/pull/987654"}]' ;;
  *) echo "boom: branch list failed" >&2; exit 1 ;;
esac
`;
  fs.writeFileSync(path.join(dir, "gh"), script, { mode: 0o755 });
  const oldPath = process.env.PATH;
  const oldRepo = process.env.GITHUB_REPO;
  process.env.PATH = `${dir}:${oldPath}`;
  process.env.GITHUB_REPO = "example/repo";
  try {
    const { syncPullRequests } = await import("../src/lib/github");
    const db = (await import("../src/lib/db")).default;
    await syncPullRequests();
    const row = db
      .prepare(`SELECT meta FROM chat_history WHERE meta LIKE '%"type":"pr"%' AND meta LIKE '%987654%'`)
      .get() as { meta: string } | undefined;
    expect(row).toBeTruthy();
  } finally {
    process.env.PATH = oldPath;
    if (oldRepo === undefined) delete process.env.GITHUB_REPO;
    else process.env.GITHUB_REPO = oldRepo;
  }
});
