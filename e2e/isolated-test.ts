import { test as base, expect } from "@playwright/test";

// Any spec that creates or mutates real data (files, docs, chat rows, ...) MUST import
// `test`/`expect` from HERE instead of "@playwright/test" directly.
//
// Why: on 2026-09-22, `npm run test:e2e:branch` isolation existed but nothing stopped these
// specs from ALSO running via the plain `npx playwright test` / `npm run test:e2e`, which hits
// Owner's real dev server on :3100 — so every run of the full suite (including ones run just to
// verify an unrelated feature) wrote fake "E2E ..." rows straight into production. Per-spec
// cleanup (see test-cleanup.ts) helped but didn't stop rows from briefly existing there, and any
// spec whose cleanup missed a row (or crashed before it ran) left it behind permanently.
//
// This fixture makes that impossible instead of merely discouraged: it skips the test outright
// unless E2E_START_SERVER=1 (set only by `npm run test:e2e:branch`, which boots its own
// throwaway server with an empty, isolated data directory — see playwright.config.ts and
// src/lib/data-dir.ts). Real data is never touched, under any invocation.
//
// 2026-09-28: the skip used to be a top-level test.beforeEach in this file. A hook declared at the
// top of a shared helper attaches only to the spec file that happened to load the helper first
// (the module is evaluated once per worker), so every other spec ran unguarded against :3100 and
// team.spec overwrote the Marketing Director's live instructions. An auto fixture is part of
// `test` itself, so it applies to every test that imports it, in every file.
export const test = base.extend<{ _isolatedOnly: void }>({
  _isolatedOnly: [
    async ({}, use, testInfo) => {
      testInfo.skip(!process.env.E2E_START_SERVER, "writes real data — only runs under `npm run test:e2e:branch` (isolated server)");
      await use();
    },
    { auto: true },
  ],
});

export { expect };
