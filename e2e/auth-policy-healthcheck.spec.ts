import { test, expect } from "@playwright/test";
import { isDeployProbe, loopbackAllowed } from "../src/lib/auth/policy";

const probeEnv = { PORT: "3101", DISABLE_SCHEDULER: "1", GLOS_TEST_SERVER: "1" };
const loop = { host: "127.0.0.1:3100" };

test("deploy probe matches only the explicit test server's GET /api/health", () => {
  expect(isDeployProbe(probeEnv, "GET", "/api/health")).toBe(true);
});

test("/api/schools is no longer open on loopback (it returns real data); /api/health is", () => {
  expect(isDeployProbe(probeEnv, "GET", "/api/schools")).toBe(false);
  expect(loopbackAllowed(loop, "GET", "/api/schools")).toBe(false);
  expect(loopbackAllowed(loop, "GET", "/api/health")).toBe(true);
});

test("deploy probe is false for the live server and other requests", () => {
  expect(isDeployProbe({ PORT: "3100", GLOS_TEST_SERVER: "1" }, "GET", "/api/health")).toBe(false);
  expect(isDeployProbe({ PORT: "3100", DISABLE_SCHEDULER: "0" }, "GET", "/api/health")).toBe(false);
  expect(isDeployProbe(probeEnv, "POST", "/api/messages")).toBe(false);
  expect(isDeployProbe(probeEnv, "GET", "/api/messages")).toBe(false);
  expect(isDeployProbe(probeEnv, "GET", "/api/health?x")).toBe(false);
  expect(isDeployProbe({ PORT: "3101", DISABLE_SCHEDULER: "1" }, "GET", "/api/health")).toBe(false);
  // A data dir alone (every member cell has one) is not a test server.
  expect(isDeployProbe({ PORT: "3101", DISABLE_SCHEDULER: "1", GENLIMITLESS_DATA_DIR: "/x" }, "GET", "/api/health")).toBe(false);
});
