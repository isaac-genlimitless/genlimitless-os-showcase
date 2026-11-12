import { test, expect } from "@playwright/test";
import { parseMissingLibs, checkBrowserLaunch } from "../src/lib/selftest";

test.describe("browser health helpers (no browser)", () => {
  test("parses the libnspr4 incident stderr", () => {
    const err =
      "/opt/genlimitless-os/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell: error while loading shared libraries: libnspr4.so: cannot open shared object file: No such file or directory";
    expect(parseMissingLibs(err)).toEqual(["libnspr4.so"]);
  });

  test("returns all unique libs", () => {
    const err = [
      "x: error while loading shared libraries: libnspr4.so: cannot open",
      "x: error while loading shared libraries: libnss3.so: cannot open",
      "x: error while loading shared libraries: libnspr4.so: cannot open",
    ].join("\n");
    expect(parseMissingLibs(err)).toEqual(["libnspr4.so", "libnss3.so"]);
  });

  test("unrelated text returns []", () => {
    expect(parseMissingLibs("everything is fine")).toEqual([]);
  });

  test("checkBrowserLaunch resolves to an object with boolean ok", async () => {
    test.setTimeout(90_000);
    const r = await checkBrowserLaunch();
    expect(typeof r.ok).toBe("boolean");
  });
});
