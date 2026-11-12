import db, { logIssue, snapshotBeforeNewTables } from "./db";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// CAPTURE INBOX: Owner throws a thought, voice note, screenshot or file at the OS (Today page) and
// keeps going. Chief files it in the background (task, calendar hold, commitment, Files page, or a
// short answer) and the result line shows on Today. Nothing here ever deletes a capture.

snapshotBeforeNewTables("captures", ["captures"]);
db.exec(`
CREATE TABLE IF NOT EXISTS captures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  attachments TEXT,                  -- JSON StoredAttachment[] (same shape as chat uploads)
  source TEXT NOT NULL DEFAULT 'today',
  status TEXT NOT NULL DEFAULT 'new', -- new | processing | filed | failed
  result TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT
);
`);

export type Capture = {
  id: number;
  text: string;
  attachments: string | null;
  source: string;
  status: "new" | "processing" | "filed" | "failed";
  result: string | null;
  attempts: number;
  created_at: string;
  processed_at: string | null;
};

export type Runner = (prompt: string) => Promise<string>;

export function listCaptures(limit = 20): Capture[] {
  return db.prepare(`SELECT * FROM captures ORDER BY id DESC LIMIT ?`).all(Math.min(Math.max(limit, 1), 100)) as Capture[];
}

export function getCapture(id: number): Capture | undefined {
  return db.prepare(`SELECT * FROM captures WHERE id=?`).get(id) as Capture | undefined;
}

export function createCapture(input: { text: string; attachments?: unknown[]; source?: string }): Capture {
  const text = (input.text || "").trim();
  const atts = input.attachments?.length ? JSON.stringify(input.attachments) : null;
  if (!text && !atts) throw new Error("Capture something: text, a voice note or a file");
  const r = db.prepare(`INSERT INTO captures (text, attachments, source) VALUES (?, ?, ?)`).run(text || "(see attached file)", atts, input.source || "today");
  return getCapture(Number(r.lastInsertRowid))!;
}

export function capturePrompt(c: Capture, attachmentNote = ""): string {
  return `CAPTURE. Owner dropped this into his capture inbox and moved on; he is NOT waiting in chat. File it so he never has to think about it again.

What he captured:
> ${c.text.split("\n").join("\n> ")}${attachmentNote}

Decide what it is and do every step that applies (check list_tasks / list_commitments / search_files first so you update instead of duplicating):
- Something to do → create_task (due date if stated or implied).
- A time, appointment or deadline → an Owner-only calendar event.
- A promise he made or one made to him → record_commitment.
- An idea, note, reference, receipt or screenshot worth keeping → the right Files page (update the living page for that topic; create_page only if none fits).
- A question → answer it in one or two sentences.
- Anything that would message someone else → a draft only; never send.
Reply with ONE line saying where it went, with internal links (e.g. "Task: Renew passport, due Dec 1 (/tasks?id=42)").`;
}

async function defaultRunner(prompt: string): Promise<string> {
  const { runAssignment } = await import("./agents/runtime");
  return runAssignment("chief_of_staff", prompt, "capture", 20);
}

/** File one capture. Claims it first so two callers can't both run it. */
export async function processCapture(id: number, runner: Runner = defaultRunner): Promise<Capture | undefined> {
  const claimed = db.prepare(`UPDATE captures SET status='processing', attempts=attempts+1 WHERE id=? AND status IN ('new','failed') AND attempts < 3`).run(id).changes;
  if (!claimed) return getCapture(id);
  const c = getCapture(id)!;
  let note = "";
  try {
    if (c.attachments) {
      const { describeAttachmentsForPrompt } = await import("./attachments");
      note = describeAttachmentsForPrompt(JSON.parse(c.attachments));
    }
  } catch {
    /* describe is best-effort */
  }
  try {
    const out = (await runner(capturePrompt(c, note))).trim();
    db.prepare(`UPDATE captures SET status='filed', result=?, processed_at=datetime('now') WHERE id=?`).run(out.slice(0, 1000), id);
  } catch (err) {
    db.prepare(`UPDATE captures SET status='failed', result=?, processed_at=datetime('now') WHERE id=?`).run(`Couldn't file it: ${errMsg(err).slice(0, 300)}`, id);
    logIssue("captures", `Capture #${id} couldn't be filed (will retry)`, errMsg(err));
  }
  return getCapture(id);
}

/** Startup + every few minutes: anything new, stuck "processing" from a restart, or failed (max 3 tries). */
export async function processPendingCaptures(runner: Runner = defaultRunner): Promise<number> {
  db.prepare(`UPDATE captures SET status='failed' WHERE status='processing' AND created_at < datetime('now','-30 minutes') AND processed_at IS NULL`).run();
  const rows = db.prepare(`SELECT id FROM captures WHERE status IN ('new','failed') AND attempts < 3 ORDER BY id ASC LIMIT 5`).all() as { id: number }[];
  for (const r of rows) await processCapture(r.id, runner);
  return rows.length;
}
