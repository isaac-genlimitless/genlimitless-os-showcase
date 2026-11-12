import { test, expect } from "@playwright/test";
import { SECRET_READ_DENY, CODE_WRITE_DENY } from "../src/lib/agent-lock";

test("secret read deny list covers server secret paths", () => {
  for (const p of [
    "Read(//proc/**)",
    "Read(//opt/genlimitless-os/shared/.env*)",
    "Read(./data/*.key)",
    "Read(./data/**/*.db*)",
  ]) {
    expect(SECRET_READ_DENY).toContain(p);
  }
});

test("secret read deny list covers other users' data, the shared accounts db and per-user env files", () => {
  for (const p of ["Read(//opt/genlimitless-os/users/**)", "Read(//opt/genlimitless-os/shared/accounts/**)", "Read(//etc/glos/**)"]) {
    expect(SECRET_READ_DENY).toContain(p);
  }
});

test("code write deny list blocks the shared server dir", () => {
  expect(CODE_WRITE_DENY).toContain("Write(//opt/genlimitless-os/shared/**)");
});

test("uploaded files stay readable", () => {
  expect(SECRET_READ_DENY.some((p) => /data\/(files|uploads)/.test(p))).toBe(false);
});
