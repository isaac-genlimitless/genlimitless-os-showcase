import fs from "fs";
import { nameFor } from "./instance";
import path from "path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { fetchSentMail } from "./mail";
import { LOCKED_BASE } from "./agent-lock";

import db from "./db";
import { DATA_DIR } from "./data-dir";
const VOICE_PATH = path.join(DATA_DIR, "voice-profile.md");
const HISTORY_DIR = path.join(DATA_DIR, "voice-history");
const SOURCES_PATH = path.join(DATA_DIR, "voice-sources.json");
const MODEL = "claude-sonnet-5-5";

type VoiceSource = { label: string; text: string; addedAt: string };

export function getVoiceProfile(): string | null {
  if (!fs.existsSync(VOICE_PATH)) return null;
  return fs.readFileSync(VOICE_PATH, "utf-8");
}

// ---------------------------------------------------------------- editing the guide in place
//
// The guide used to change only by being rebuilt from scratch, and "update the voice guide" really
// meant adding a separate one-line insight that never reached the guide. Now a lesson is edited
// straight into the section it belongs to. Every edit keeps a copy of the previous guide and a row
// here; the add/replace rows are also what a full rebuild must keep ("rules Owner taught").

db.exec(`CREATE TABLE IF NOT EXISTS voice_guide_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,          -- add | replace | remove | rebuild
  section TEXT,
  old_text TEXT,
  new_text TEXT,
  reason TEXT,
  changed_by TEXT NOT NULL,      -- an agent slug, owner, or migration
  backup TEXT,                   -- file in data/voice-history holding the guide before this change
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

function backupGuide(current: string): string {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const name = `voice-profile-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 6)}.md`;
  fs.writeFileSync(path.join(HISTORY_DIR, name), current, "utf-8");
  return name;
}

type Section = { heading: string; start: number; end: number }; // [start, end) line indexes, heading line included

function sections(lines: string[]): Section[] {
  const out: Section[] = [];
  lines.forEach((l, i) => {
    if (/^##\s/.test(l)) {
      if (out.length) out[out.length - 1].end = i;
      out.push({ heading: l.replace(/^##\s+/, "").trim(), start: i, end: lines.length });
    }
  });
  return out;
}

function findSection(lines: string[], name: string): Section | undefined {
  const want = name.toLowerCase().replace(/^#+\s*/, "").trim();
  const all = sections(lines);
  return all.find((s) => s.heading.toLowerCase() === want) || all.find((s) => s.heading.toLowerCase().includes(want));
}

export type VoiceEdit = {
  action: "add" | "replace" | "remove";
  section?: string; // add: the heading to add under (created if missing)
  text?: string; // add: the new rule; replace: the replacement
  old_text?: string; // replace/remove: exact text currently in the guide
  reason: string;
};

/** Edit the guide in place: add a rule to a section, or replace/remove exact text. */
export function updateVoiceGuide(edit: VoiceEdit, by: string) {
  const current = getVoiceProfile();
  if (!current) throw new Error("No voice guide yet. Build one first (Refresh in the chat sidebar).");
  let next: string;
  let section = edit.section || null;

  if (edit.action === "add") {
    if (!edit.text?.trim()) throw new Error("add needs text (the rule to add).");
    if (!edit.section?.trim()) throw new Error(`add needs a section. Current sections: ${sections(current.split("\n")).map((s) => s.heading).join(" | ")}`);
    const lines = current.split("\n");
    const bullet = edit.text.trim().startsWith("- ") ? edit.text.trim() : `- ${edit.text.trim()}`;
    const sec = findSection(lines, edit.section);
    if (sec) {
      let at = sec.end; // after the section's last non-blank line
      while (at > sec.start + 1 && !lines[at - 1].trim()) at--;
      lines.splice(at, 0, bullet);
      section = sec.heading;
    } else {
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      lines.push("", `## ${edit.section.trim()}`, bullet);
    }
    next = lines.join("\n");
  } else {
    const old = edit.old_text;
    if (!old?.trim()) throw new Error(`${edit.action} needs old_text: the exact words currently in the guide (get_voice_guide to copy them).`);
    const hits = current.split(old).length - 1;
    if (hits === 0) throw new Error("old_text isn't in the guide word for word. Copy it exactly from get_voice_guide.");
    if (hits > 1) throw new Error(`old_text appears ${hits} times. Include more of the surrounding words so it matches once.`);
    if (edit.action === "replace") {
      if (!edit.text?.trim()) throw new Error("replace needs text (the new wording).");
      next = current.replace(old, edit.text.trim());
    } else {
      // Removing a whole bullet takes its line with it; otherwise just the words.
      const lines = current.split("\n");
      const i = lines.findIndex((l) => l.includes(old));
      next = lines[i].replace(/^[-*]\s+/, "").trim() === old.replace(/^[-*]\s+/, "").trim() ? [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n") : current.replace(old, "");
    }
    if (!section) section = sections(current.split("\n")).find((s) => current.split("\n").slice(s.start, s.end).join("\n").includes(old))?.heading || null;
  }

  const backup = backupGuide(current);
  fs.writeFileSync(VOICE_PATH, next, "utf-8");
  const row = db
    .prepare(`INSERT INTO voice_guide_changes (action, section, old_text, new_text, reason, changed_by, backup) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(edit.action, section, edit.old_text ?? null, edit.text?.trim() ?? null, edit.reason, by, backup);
  return {
    change_id: Number(row.lastInsertRowid),
    action: edit.action,
    section,
    ...(edit.old_text ? { was: edit.old_text } : {}),
    ...(edit.text ? { now: edit.text.trim() } : {}),
    guide_words: next.split(/\s+/).filter(Boolean).length,
    note: "Saved in place. The previous guide is backed up; every future draft uses the new wording.",
  };
}

export function listVoiceGuideChanges(limit = 20) {
  return db
    .prepare(`SELECT id, action, section, old_text, new_text, reason, changed_by, created_at FROM voice_guide_changes ORDER BY id DESC LIMIT ?`)
    .all(Math.min(limit, 100));
}

/** Rules Owner taught (directly or through his edits), oldest first, minus ones later removed. */
function taughtRules(): string[] {
  const rows = db.prepare(`SELECT action, old_text, new_text FROM voice_guide_changes WHERE action IN ('add','replace','remove') ORDER BY id`).all() as {
    action: string;
    old_text: string | null;
    new_text: string | null;
  }[];
  let rules: string[] = [];
  for (const r of rows) {
    if (r.action !== "add" && r.old_text) rules = rules.filter((x) => !x.includes(r.old_text!.trim()));
    if (r.action !== "remove" && r.new_text) rules.push(r.new_text.replace(/^-\s+/, ""));
  }
  return rules;
}

function loadSources(): VoiceSource[] {
  if (!fs.existsSync(SOURCES_PATH)) return [];
  return JSON.parse(fs.readFileSync(SOURCES_PATH, "utf-8"));
}

/** Persists an extra example thread (e.g. a client email chain) so future
 * profile regenerations keep learning from it, not just the most recent one. */
export function addVoiceSource(label: string, text: string) {
  const sources = loadSources();
  sources.push({ label, text, addedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(SOURCES_PATH), { recursive: true });
  fs.writeFileSync(SOURCES_PATH, JSON.stringify(sources, null, 2), "utf-8");
}

export async function regenerateVoiceProfile(): Promise<string> {
  const sent = await fetchSentMail(60);
  const realEmails = sent.filter((m) => m.text && m.text.trim().length > 20).slice(0, 40);
  const sources = loadSources();

  if (realEmails.length === 0 && sources.length === 0) {
    throw new Error("No sent emails found to learn from yet.");
  }

  const taught = taughtRules();
  const sample = realEmails
    .map((m) => `Subject: ${m.subject}\nTo: ${m.to}\n\n${m.text}`)
    .join("\n\n---\n\n");

  const extraSection = sources.length
    ? "\n\n" +
      sources
        .map((s) => `ADDITIONAL REAL THREAD (${s.label}):\n\n${s.text}`)
        .join("\n\n---\n\n")
    : "";

  const prompt = `Below are real emails Owner has sent from his own account. Study them and write a concise "voice profile" — a practical style guide another writer (or AI) could follow to write new emails that sound like Owner wrote them.

Cover: typical greeting/sign-off, sentence length and rhythm, tone (formal vs casual), vocabulary he favors or avoids, punctuation habits (e.g. whether he ever uses em dashes, exclamation points, emoji), how he structures a pitch or ask, how long his emails usually run, and any recurring phrases or quirks. Be specific and give a couple of short verbatim examples of phrasing he actually uses.

Some additional real threads may be included below with different relationship contexts (a paying client, a warm referral/networking contact, etc). If so, add short separate sections describing how his tone shifts in each context — e.g. a first note to a stranger vs. an existing client vs. a warm intro through a mutual connection. Note things like: does he mention shared affiliations/communities, how persistent he is about scheduling, how he signs off differently in each context.

Some sources may be SPOKEN (a video or call transcript, labeled as such). Use those for a separate "Spoken pitch / demo" section: how he frames the idea, the trust/control points he returns to, the concrete specifics he uses, and how he closes. Then add 2–3 bullets on what from the spoken pitch should carry into short cold emails. Ignore filler words ("um", "uh") — they're speech artifacts, not style.

A source whose label starts with FINAL contains cold emails Owner himself rewrote and approved. Treat it as the most authoritative evidence of how he wants cold emails to sound NOW: where it conflicts with older emails, follow FINAL (pitch structure, the opening line, how the video is introduced, how control and approval are stated), and describe the pitch structure in the order those final emails actually use it.

Keep the whole thing under 1200 words. Output ONLY the style guide in markdown, no preamble.${
    taught.length
      ? `

RULES OWNER HAS TAUGHT (from his corrections and his edits to drafts, oldest first). These are the most authoritative evidence of all: they override anything the emails below suggest. Keep EVERY one in the new guide, in the section it belongs to, in close to these words. Where two conflict, the later one wins.
${taught.map((r) => `- ${r}`).join("\n")}`
      : ""
  }

COLD/SENT EMAILS:
${sample || "(none available)"}${extraSection}`;

  const result = query({
    prompt: nameFor(prompt),
    options: {
      model: MODEL,
      ...LOCKED_BASE,
      tools: [], // pure text generation: no tools at all
      allowedTools: [],
      maxTurns: 2,
    },
  });

  let profile = "";
  for await (const message of result) {
    if (message.type === "result" && message.subtype === "success") {
      profile = message.result.trim();
    }
  }
  if (!profile) throw new Error("Failed to generate a voice profile.");

  fs.mkdirSync(path.dirname(VOICE_PATH), { recursive: true });
  const previous = getVoiceProfile();
  const backup = previous ? backupGuide(previous) : null;
  fs.writeFileSync(VOICE_PATH, profile, "utf-8");
  db.prepare(`INSERT INTO voice_guide_changes (action, reason, changed_by, backup) VALUES ('rebuild', ?, 'owner', ?)`).run(
    `Full rebuild from ${realEmails.length} sent emails, ${sources.length} saved threads and ${taught.length} taught rules`,
    backup
  );
  return profile;
}
