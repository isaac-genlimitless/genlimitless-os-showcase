import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveAccountsDir } from "./accounts/dir";

const cwd = "/work/clone";

test("ACCOUNTS_DIR always wins", () => {
  assert.equal(resolveAccountsDir({ ACCOUNTS_DIR: "/tmp/a" } as any, () => true, cwd), path.resolve("/tmp/a"));
});

test("on the server (/opt/genlimitless-os/shared exists) the shared accounts folder is used", () => {
  assert.equal(resolveAccountsDir({} as any, () => true, cwd), "/opt/genlimitless-os/shared/accounts");
});

test("explicit GLOS_ROOT keeps the old behaviour even if the folder is missing", () => {
  assert.equal(resolveAccountsDir({ GLOS_ROOT: "/srv/glos" } as any, () => false, cwd), "/srv/glos/shared/accounts");
});

test("a local clone with nothing configured keeps accounts next to its data", () => {
  assert.equal(resolveAccountsDir({} as any, () => false, cwd), path.join(cwd, "data", "accounts"));
  assert.equal(
    resolveAccountsDir({ GENLIMITLESS_DATA_DIR: "/tmp/d" } as any, () => false, cwd),
    path.join(path.resolve("/tmp/d"), "accounts"),
  );
});

test("test processes are still refused without ACCOUNTS_DIR", () => {
  assert.throws(() => resolveAccountsDir({ TEST_WORKER_INDEX: "0" } as any, () => false, cwd), /Refusing/);
});
