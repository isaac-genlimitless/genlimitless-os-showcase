// --- Trigger: a fenced ```schedule-review 2026-09-24``` block in a chat reply ---

const SCHEDULE_REVIEW_RE = /```schedule-review\s+(\d{4}-\d{2}-\d{2})\s*```/;

export function parseScheduleReview(content: string): { date: string; stripped: string } | null {
  const match = content.match(SCHEDULE_REVIEW_RE);
  if (!match || match.index === undefined) return null;
  const stripped = (content.slice(0, match.index) + content.slice(match.index + match[0].length)).trim();
  return { date: match[1], stripped };
}
