import { parseEraNote } from "../timeline/era-md";
import { resolveBackupFolder, type TimelineXmlSyncSettings } from "../settings";
import type { VaultAdapter } from "./vault-adapter";

/**
 * Where the note for an era lives. The default is `_eras/<id>.md`, but the user
 * may have renamed or moved it, so a note under `_eras/` that declares this
 * `era_id` wins over assuming the file name. Without this, saving or importing
 * an era whose note was renamed would write a second note with the same id.
 */
export async function findEraNotePath(
  vault: VaultAdapter,
  s: TimelineXmlSyncSettings,
  eraId: string
): Promise<string | null> {
  const erasDir = `${s.eventNotesDir}/_eras`;
  const files = vault.listMarkdownFiles(erasDir, resolveBackupFolder(s));
  const fallback = `${erasDir}/${eraId}.md`;
  // The default name first: by far the common case, and one read.
  files.sort((a, b) => Number(b.path === fallback) - Number(a.path === fallback));
  for (const f of files) {
    try {
      const era = parseEraNote(await vault.readText(f.path), f.basename);
      if (era?.id === eraId) return f.path;
    } catch {
      // unreadable right now (mid-sync): look at the others
    }
  }
  // Something is at the default name but is not a readable era note: keep
  // treating it as the era's note, as before, so the caller's own checks
  // (skip an unparseable note, say) still apply instead of a twin being written.
  return vault.exists(fallback) ? fallback : null;
}
