import { test, expect } from "./isolated-test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keepPreviousStatic } from "../src/lib/keep-previous-static";

// File-system only test: no UI, never sends anything or runs an agent.
test("keepPreviousStatic carries the previous build's recent files forward, safely", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kps-"));
  try {
    const A = path.join(root, "releases", "A");
    const B = path.join(root, "releases", "B");
    const ca = path.join(A, ".next", "static", "chunks");
    const cb = path.join(B, ".next", "static", "chunks");
    fs.mkdirSync(ca, { recursive: true });
    fs.mkdirSync(cb, { recursive: true });
    fs.writeFileSync(path.join(ca, "old.js"), "old-A");
    fs.writeFileSync(path.join(ca, "ancient.js"), "ancient-A");
    const past = new Date(Date.now() - 30 * 86_400_000);
    fs.utimesSync(path.join(ca, "ancient.js"), past, past);
    fs.writeFileSync(path.join(ca, "shared.js"), "shared-A");
    fs.writeFileSync(path.join(cb, "new.js"), "new-B");
    fs.writeFileSync(path.join(cb, "shared.js"), "shared-B");
    fs.symlinkSync(B, path.join(root, "current"));
    fs.symlinkSync(A, path.join(root, "previous"));

    expect(await keepPreviousStatic({ root, cwd: B })).toBe(1);
    expect(fs.readFileSync(path.join(cb, "old.js"), "utf8")).toBe("old-A");
    expect(fs.existsSync(path.join(cb, "ancient.js"))).toBe(false);
    expect(fs.readFileSync(path.join(cb, "shared.js"), "utf8")).toBe("shared-B");
    expect(fs.readFileSync(path.join(cb, "new.js"), "utf8")).toBe("new-B");

    // Not the live release: does nothing.
    fs.rmSync(path.join(cb, "old.js"));
    expect(await keepPreviousStatic({ root, cwd: A })).toBe(0);
    expect(fs.existsSync(path.join(cb, "old.js"))).toBe(false);

    // No previous release: returns 0, no throw.
    fs.unlinkSync(path.join(root, "previous"));
    expect(await keepPreviousStatic({ root, cwd: B })).toBe(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
