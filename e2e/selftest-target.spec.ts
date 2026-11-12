import { test, expect } from "@playwright/test";
import { e2eBaseUrl } from "../src/lib/selftest-target";

test("defaults to the real OS port 3100", () => {
  expect(e2eBaseUrl({})).toBe("http://localhost:3100");
});

test("PORT overrides the default", () => {
  expect(e2eBaseUrl({ PORT: "3101" })).toBe("http://localhost:3101");
});

test("E2E_BASE_URL is used and trailing slash trimmed", () => {
  expect(e2eBaseUrl({ E2E_BASE_URL: "http://localhost:3200/" })).toBe("http://localhost:3200");
});

test("E2E_BASE_URL wins over PORT", () => {
  expect(e2eBaseUrl({ E2E_BASE_URL: "http://localhost:3200", PORT: "3101" })).toBe("http://localhost:3200");
});
