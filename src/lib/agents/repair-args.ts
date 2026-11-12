// No imports: pure, so specs can test it without opening the database.

/** Long tool calls sometimes come through with later parameters written as text inside an earlier
 *  one ('...</diagnosis>\n<proposed_change>...</proposed_change>\n<files>[...]</files>'). Run #90
 *  lost a whole design to 4 rejected retries. Pull those parameters back out. */
export function repairSpilledArgs(input: Record<string, any>, keys: string[]): Record<string, any> {
  const out = { ...input };
  for (const field of keys) {
    const s = out[field];
    if (typeof s !== "string") continue;
    const cut = s.search(new RegExp(`</${field}>|<(${keys.join("|")})>`));
    if (cut < 0) continue;
    out[field] = s.slice(0, cut).trim();
    for (const k of keys) {
      const m = s.slice(cut).match(new RegExp(`<${k}>([\\s\\S]*?)</${k}>`));
      if (!m || (out[k] !== undefined && out[k] !== "" && k !== field)) continue;
      const v = m[1].trim();
      if (k === "files") {
        try {
          out[k] = JSON.parse(v);
        } catch {
          out[k] = v.split(/[\n,]/).map((f) => f.trim()).filter(Boolean);
        }
      } else out[k] = v;
    }
  }
  if (out.size !== undefined && !["minor", "major"].includes(out.size)) out.size = "major";
  return out;
}
