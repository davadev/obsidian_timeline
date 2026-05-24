/** Deterministic slug for event IDs (also used for MD filenames). */

const DIACRITICS_RE = /[̀-ͯ]/g;

export function slugify(input: string, maxLen = 80): string {
  if (!input) return "event";
  const lowered = input
    .normalize("NFKD")
    .replace(DIACRITICS_RE, "")
    .toLowerCase();
  const cleaned = lowered
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const trimmed = cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
  return trimmed || "event";
}

/** Unique slug given a set of already-used slugs; appends -2, -3, ... */
export function uniqueSlug(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let i = 2;
  while (used.has(`${base}-${i}`)) i++;
  const out = `${base}-${i}`;
  used.add(out);
  return out;
}
