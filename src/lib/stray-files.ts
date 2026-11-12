// Finds leftover scratch files (.append, .tmp, .bak, .orig, .rej, trailing ~) that weren't declared in the proposal.
const STRAY = /(\.(append|tmp|bak|orig|rej)|~)$/i;

export function findStrays(changed: string[], listed: string[]): string[] {
  const declared = new Set(listed);
  return changed.filter((f) => STRAY.test(f) && !declared.has(f));
}

/** Scratch-looking files that the proposal explicitly listed (kept, but still noted). */
export function findListedStrays(changed: string[], listed: string[]): string[] {
  const declared = new Set(listed);
  return changed.filter((f) => STRAY.test(f) && declared.has(f));
}
