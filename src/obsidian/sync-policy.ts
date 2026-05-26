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
