import { test, expect } from "./isolated-test";
import type { ImapFlow, FetchMessageObject } from "imapflow";
import { processNewMessages, resolveStartUid } from "../src/lib/imap-idle";
import { openTestDb } from "./db-handle";

// Regression test: the very first watch of an account must never treat its entire pre-existing
// mailbox history as new mail. processNewMessages / resolveStartUid are called directly with a fake
// IMAP client and a spy in place of the inbound sweep: no real mailbox, nothing sent, no agent run.

const stamp = Date.now();

function dbHandle() {
  return openTestDb();
}

function rawMessage(opts: { uid: number; from: string; subject: string; body: string; messageId: string }) {
  return Buffer.from(
    `From: ${opts.from}\r\n` +
      `To: watched-account@example.org\r\n` +
      `Subject: ${opts.subject}\r\n` +
      `Message-ID: ${opts.messageId}\r\n` +
      `Date: ${new Date(2017, 0, 1).toUTCString()}\r\n` +
      `\r\n` +
      `${opts.body}\r\n`
  );
}

function fakeClient(messages: { uid: number; source: Buffer }[], uidNext: number): ImapFlow {
  return {
    mailbox: { exists: messages.length, uidNext },
    fetch: async function* () {
      for (const m of messages) yield m as unknown as FetchMessageObject;
    },
  } as unknown as ImapFlow;
}

test.describe("first connect never backfills pre-existing mailbox history as new mail", () => {
  const account = `imap-first-connect-${stamp}@example.org`;

  test.afterAll(() => {
    if (!process.env.E2E_START_SERVER) return; // hooks still run for skipped tests; nothing was written
    const db = dbHandle();
    try {
      db.prepare(`DELETE FROM imap_watch_state WHERE account = ?`).run(account);
    } finally {
      db.close();
    }
  });

  test("no imap_watch_state row yet: pre-existing mail is skipped, not processed", async () => {
    const db = dbHandle();
    const existing = db.prepare(`SELECT 1 FROM imap_watch_state WHERE account = ?`).get(account);
    db.close();
    expect(existing).toBeUndefined();

    // Mailbox already has 3 old messages (uid 1-3); uidNext is 4.
    const oldMessages = [1, 2, 3].map((uid) => ({
      uid,
      source: rawMessage({
        uid,
        from: `old.person.${uid}.${stamp}@example.org`,
        subject: `2017 thread ${uid}`,
        body: "Can we hop on a call sometime to meet up?",
        messageId: `<old-${uid}-${stamp}@example.org>`,
      }),
    }));

    const startUid = resolveStartUid(account, 4);
    expect(startUid).toBe(3); // baselines to current highest UID, not 0

    const client = fakeClient(oldMessages, 4);
    const woke: number[] = [];
    const lastUid = await processNewMessages(client, account, startUid, (_a, n) => woke.push(n));
    expect(lastUid).toBe(3);
    expect(woke).toEqual([]); // nothing newer than the baseline, so the sweep isn't woken
  });

  test("after a baseline is persisted, a real reconnect/sleep gap still catches up new mail", async () => {
    // Simulate what watchAccountOnce persists after the first-connect baseline above.
    const db = dbHandle();
    db.prepare(
      `INSERT INTO imap_watch_state (account, last_uid, status, updated_at) VALUES (?, 3, 'watching', datetime('now'))
       ON CONFLICT(account) DO UPDATE SET last_uid = excluded.last_uid`
    ).run(account);
    db.close();

    // A row now exists, so resolveStartUid resumes from it regardless of the mailbox's uidNext.
    const startUid = resolveStartUid(account, 999);
    expect(startUid).toBe(3);

    // Mailbox gained 2 new messages (uid 4, 5) while disconnected, alongside the old uid 1-3.
    const allMessages = [1, 2, 3, 4, 5].map((uid) => ({
      uid,
      source: rawMessage({
        uid,
        from: `sender.${uid}.${stamp}@example.org`,
        subject: `Message ${uid}`,
        body: "Just checking in, nothing urgent.",
        messageId: `<msg-${uid}-${stamp}@example.org>`,
      }),
    }));

    const client = fakeClient(allMessages, 6);
    const woke: number[] = [];
    const lastUid = await processNewMessages(client, account, startUid, (_a, n) => woke.push(n));
    expect(lastUid).toBe(5);
    expect(woke).toEqual([2]); // only the genuinely new mail (uid 4, 5), not the old uid 1-3
  });
});
