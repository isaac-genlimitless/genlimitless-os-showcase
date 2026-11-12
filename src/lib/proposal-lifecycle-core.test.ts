import test from "node:test";
import assert from "node:assert/strict";
import { hasEnded, staleTextReasons, staleEmailReasons, normSubject, bareAddress, textKey } from "./proposal-lifecycle-core";

test("hasEnded", () => {
  const now = Date.parse("2026-11-07T20:00:00-06:00");
  assert.equal(hasEnded("2026-11-05T17:00:00-06:00", "2026-11-05", now, "2026-11-07"), true);
  assert.equal(hasEnded("2026-11-07T21:00:00-06:00", "2026-11-07", now, "2026-11-07"), false);
  assert.equal(hasEnded("garbage", "2026-11-05", now, "2026-11-07"), true);
});

test("staleTextReasons", () => {
  const p = [1, 2, 3, 4, 5].map((id) => ({ id, key: "8015551234" }));
  p.push({ id: 6, key: "9995551234" });
  const r = staleTextReasons(p, []);
  assert.deepEqual([...r.keys()].sort(), [1, 2, 3, 4]);
  assert.ok(!r.has(5) && !r.has(6));
  const r2 = staleTextReasons([{ id: 1, key: "a" }], [{ id: 9, key: "a" }]);
  assert.ok(r2.has(1));
  assert.equal(staleTextReasons([{ id: 1, key: "" }, { id: 2, key: "" }], []).size, 0);
});

const c = (id: number, subject: string, at: string, thread: string | null = null, address = "g@x.com") => ({ id, address, subject, thread, at });

test("staleEmailReasons", () => {
  const d1 = { ...c(1, "Shift", "2026-11-07 10:00:00", "t1"), isReply: false };
  const d2 = { ...c(2, "Shift", "2026-11-07 11:00:00", "t1"), isReply: false };
  const r = staleEmailReasons([d1, d2], [d1, d2].map((d) => ({ ...d, kind: "draft" as const })));
  assert.ok(r.has(1) && !r.has(2));

  const a = { ...c(1, "Shift", "2026-11-07 10:00:00"), isReply: false };
  const b = { ...c(2, "Re: Shift", "2026-11-07 11:00:00"), isReply: true };
  assert.ok(staleEmailReasons([a, b], [{ ...b, kind: "draft" }]).has(1));

  const other = c(3, "Different", "2026-11-07 12:00:00");
  assert.equal(staleEmailReasons([a], [{ ...other, kind: "draft" }]).size, 0);

  assert.ok(staleEmailReasons([a], [{ ...c(7, "Re: Shift", "2026-11-07 10:30:00"), kind: "sent" }]).has(1));

  const reply = { ...c(1, "Re: Shift", "2026-11-07 10:00:00"), isReply: true };
  const inbound = { ...c(8, "Shift", "2026-11-07 10:30:00"), kind: "inbound" as const };
  assert.ok(staleEmailReasons([reply], [inbound]).has(1));
  assert.equal(staleEmailReasons([a], [inbound]).size, 0);
  assert.equal(staleEmailReasons([reply], [{ ...inbound, at: "2026-11-07 09:00:00" }]).size, 0);
});

test("normalizers", () => {
  assert.equal(normSubject("RE: Fwd: Shift  now"), "shift now");
  assert.equal(bareAddress("Gabriel <G@x.com>"), "g@x.com");
  assert.equal(textKey("+1 (801) 555-1234"), "8015551234");
  assert.equal(textKey(null, "any;-;+18015551234"), "8015551234");
  assert.equal(textKey(null, "chat123456789"), "chat123456789");
});
