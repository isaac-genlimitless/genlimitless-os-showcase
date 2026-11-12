import { test, expect } from "@playwright/test";
import { titleOf } from "../src/lib/notion-text";

// Pure-function tests: no browser, no network, no Notion writes.

test("a page's title comes from its title property", () => {
  const page = { object: "page", properties: { Name: { type: "title", title: [{ plain_text: "Deal" }] } } };
  expect(titleOf(page)).toBe("Deal");
});

test("a database's title is read without throwing on the {} title schema", () => {
  const database = { object: "database", title: [{ plain_text: "Deals DB" }], properties: { Name: { type: "title", title: {} } } };
  expect(() => titleOf(database)).not.toThrow();
  expect(titleOf(database)).toBe("Deals DB");
});

test("a database with an empty title falls back to Untitled", () => {
  const database = { object: "database", title: [], properties: { Name: { type: "title", title: {} } } };
  expect(titleOf(database)).toBe("Untitled");
});
