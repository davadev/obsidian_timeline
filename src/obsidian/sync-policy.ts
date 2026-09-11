/**
 * Pure decision helpers for multi-device sync conflict handling.
 * Kept obsidian-free so they can be exercised from vitest without mocking
 * the Vault API.
 */

/**
 * Decide whether importXml should refuse to overwrite an existing MD note.
 * Skip when the file has been modified locally after the last XML-driven
 * write (file mtime newer than stamp). Notes with no stamp are skipped too —
 * we have no way to know whether they carry user edits.
 */
export function shouldSkipNoteOverwrite(
  fileMtime: number | undefined,
  noteStamp: number | undefined,
  graceMs = 2000
): boolean {
  if (fileMtime == null) return false; // no existing file → safe to write
  if (noteStamp == null) return true; // unknown provenance → skip
  return fileMtime > noteStamp + graceMs;
}

/**
 * CAS-style guard for regenerateXml. Abort the write when the XML file's
 * mtime moved between the in-memory read and the about-to-happen write AND
 * the new mtime does not match our last own write (so the change came from
 * outside the plugin — remote sync).
 */
export function shouldAbortXmlWrite(
  baseMtime: number | null,
  currentMtime: number | null,
  ourLastWriteMtime: number | null,
  driftToleranceMs = 1000
): boolean {
  if (baseMtime == null || currentMtime == null) return false;
  if (currentMtime <= baseMtime + driftToleranceMs) return false;
  return currentMtime !== ourLastWriteMtime;
}

/**
 * Cheap content fingerprint (FNV-1a, 32-bit) used to tell a real edit from a
 * file whose mtime moved without its contents changing.
 */
export function contentFingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${text.length.toString(36)}-${h.toString(36)}`;
}

export type ExternalXmlVerdict =
  /** Nothing moved; nothing to do. */
  | { kind: "unchanged" }
  /** mtime moved but the bytes did not — re-stamp quietly. */
  | { kind: "touched" }
  /** The file really is different from what we last saw. */
  | { kind: "changed" };

/**
 * Decides what a changed mtime on the XML actually means.
 *
 * Remote sync clients rewrite a file when they re-download it, and iCloud in
 * particular updates mtime on files it has merely re-materialised. Treating
 * that as an edit is what produced "Timeline XML changed externally" warnings
 * for files nobody had touched. A fingerprint of the contents settles it: only
 * a different fingerprint is a real change.
 */
export function classifyExternalXml(args: {
  mtime: number | null;
  lastWrittenMtime: number | null;
  /** Fingerprint of the file now — only read when the mtime moved. */
  fingerprint?: string | null;
  lastFingerprint?: string | null;
  graceMs?: number;
}): ExternalXmlVerdict {
  const grace = args.graceMs ?? 2000;
  if (args.mtime == null || args.lastWrittenMtime == null) {
    return { kind: "unchanged" };
  }
  if (args.mtime <= args.lastWrittenMtime + grace) return { kind: "unchanged" };

  // Without fingerprints to compare we can only go on the timestamp.
  if (args.fingerprint == null || args.lastFingerprint == null) {
    return { kind: "changed" };
  }
  return args.fingerprint === args.lastFingerprint
    ? { kind: "touched" }
    : { kind: "changed" };
}
