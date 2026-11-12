import { test, expect } from "@playwright/test";
import { buildWhere, buildQueryUrl, queryOpenData } from "../src/lib/open-data";

// Pure-function checks (no UI, never presses Send or triggers an agent). The live check needs E2E_LIVE=1.

test("buildWhere rejects quotes, semicolons, comments, emails and long strings", () => {
  expect(() => buildWhere({ owner_contains: "O'BRIEN" })).toThrow();
  expect(() => buildWhere({ owner_contains: "RENTALS; DROP" })).toThrow();
  expect(() => buildWhere({ owner_contains: "RENTALS--x" })).toThrow();
  expect(() => buildWhere({ owner_contains: "owner@example.com" })).toThrow();
  expect(() => buildWhere({ owner_contains: "A".repeat(41) })).toThrow();
  expect(buildWhere({ owner_contains: "rentals" })).toContain("%RENTALS%");
});

test("buildQueryUrl always targets the fixed host and path with f=json", () => {
  for (const mode of ["owners", "parcels", "land_use_values"] as const) {
    const u = buildQueryUrl({ mode, owner_contains: "HOLDINGS", min_parcels: mode === "owners" ? 3 : undefined });
    expect(u.hostname).toBe("services2.arcgis.com");
    expect(u.pathname).toBe("/HdTo6HJqh92wn4D8/arcgis/rest/services/Parcels_view/FeatureServer/0/query");
    expect(u.searchParams.get("f")).toBe("json");
  }
});

test("min_parcels outside 2-500 is rejected", () => {
  expect(() => buildQueryUrl({ mode: "owners", min_parcels: 1 })).toThrow();
  expect(() => buildQueryUrl({ mode: "owners", min_parcels: 501 })).toThrow();
  expect(() => buildQueryUrl({ mode: "owners", min_parcels: 3 })).not.toThrow();
});

test("live: owners mode returns small-landlord rows", async () => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to hit the public service");
  const r = await queryOpenData({ mode: "owners", owner_contains: "RENTALS", min_parcels: 3, limit: 5 });
  expect(r.rows.length).toBeGreaterThanOrEqual(1);
  expect(r.rows[0].Owner).toBeTruthy();
  expect(r.rows[0].OwnCity).toBeTruthy();
});
