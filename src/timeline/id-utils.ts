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
  if (trimmed) return trimmed;
  return unicodeSlug(lowered, maxLen);
}

/**
 * Titles in Greek, Hebrew, Cyrillic, CJK ... have no a-z0-9 at all, so the
 * ASCII slug is empty and every such event would be called "event". Keep the
 * letters and digits of any script instead. Only used when the ASCII slug is
 * empty, so ids that already exist never change.
 */
function unicodeSlug(lowered: string, maxLen: number): string {
  const cleaned = lowered
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return Array.from(cleaned).slice(0, maxLen).join("").replace(/-+$/, "") || "event";
}

/**
 * A file name for an id taken from outside the vault (an XML `id` attribute
 * can hold anything): path separators and characters Obsidian or the OS reject
 * become "-". Ordinary ids pass through unchanged.
 */
export function safeFileName(id: string): string {
  return (
    id
      .replace(/(?:\s*[\\/:*?"<>|#^[\]])+\s*/g, "-")
      .replace(/^[.\s]+|[.\s]+$/g, "") || "event"
  );
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
