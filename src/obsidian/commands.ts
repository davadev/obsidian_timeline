import { Notice, type App, type Plugin } from "obsidian";
import { EVENT_NOTE_SCHEMA_VERSION, type TimelineXmlSyncSettings } from "../settings";
import type { VaultAdapter } from "./vault-adapter";
import type { TemplateService } from "./template-service";
import type { TimelineCache } from "./cache";
import { writeTimelineXml } from "../timeline/xml-writer";
import { renderEventMarkdown } from "../timeline/markdown-writer";
import { parseEventNote } from "../timeline/markdown-parser";
import { validateAll } from "../timeline/validator";
import { mergeNotesIntoDoc } from "../timeline/sync-engine";
import type { EventNote, TimelineCategory } from "../timeline/model";
import {
  shouldSkipNoteOverwrite,
  shouldAbortXmlWrite,
} from "./sync-policy";
import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  guessImageExtension,
} from "../timeline/base64";
import { renderEraMarkdown } from "../timeline/era-md";

export interface CommandsContext {
  app: App;
  plugin: Plugin;
  vault: VaultAdapter;
  templates: TemplateService;
  cache: TimelineCache;
  getSettings: () => TimelineXmlSyncSettings;
  saveSettings: () => Promise<void>;
  /**
   * Suppress sync loop while plugin itself writes files. Pass `paths` so the
   * suppression is scoped to those files instead of suppressing everything.
   */
  withSelfWrite: <T>(fn: () => Promise<T>, paths?: string[]) => Promise<T>;
  /** Replace stored diagnostics. */
  setDiagnostics: (lines: string[]) => void;
  /** Interactive "new event" flow: prompt title, create note, open inspector. */
  createEventInteractive: () => Promise<void>;
  /** Append a structured line to the sync log (best-effort). */
  appendSyncLog: (event: string, path: string, detail: string) => Promise<void>;
}

export function registerCommands(ctx: CommandsContext): void {
  const { plugin } = ctx;

  plugin.addCommand({
    id: "txs-import",
    name: "Import XML to Markdown event notes",
    callback: () => importXml(ctx).catch(reportErr),
  });

  plugin.addCommand({
    id: "txs-validate",
    name: "Validate all timeline event notes",
    callback: () => validateNotes(ctx).catch(reportErr),
  });

  plugin.addCommand({
    id: "txs-regenerate",
    name: "Regenerate XML from Markdown",
    callback: () => regenerateXml(ctx).catch(reportErr),
  });

  plugin.addCommand({
    id: "txs-create-template",
    name: "Create/Update event note template",
    callback: () =>
      ctx.templates
        .createOrUpdateTemplate()
        .then((p) => new Notice(`Template written: ${p}`))
        .catch(reportErr),
  });

  plugin.addCommand({
    id: "txs-create-event",
    name: "New timeline event (prompt + open inspector)",
    callback: () => ctx.createEventInteractive().catch(reportErr),
  });

  plugin.addCommand({
    id: "txs-diagnostics",
    name: "Open timeline sync diagnostics",
    callback: () => openDiagnostics(ctx).catch(reportErr),
  });

  plugin.addCommand({
    id: "txs-rebuild-index",
    name: "Rebuild internal index/cache",
    callback: () => rebuildIndex(ctx).catch(reportErr),
  });

  plugin.addCommand({
    id: "txs-wipe-reimport",
    name: "Wipe event notes and reimport from XML",
    callback: () => wipeAndReimport(ctx).catch(reportErr),
  });

  plugin.addCommand({
    id: "txs-auto-detect",
    name: "Auto-detect event notes (scan vault)",
    callback: () => autoDetectEventNotes(ctx).catch(reportErr),
  });

  plugin.addCommand({
    id: "txs-auto-detect-xml",
    name: "Auto-detect .timeline XML file (scan vault)",
    callback: () => autoDetectXml(ctx).catch(reportErr),
  });
}

/**
 * Walks the vault for `.timeline` files and picks one.
 * - exactly 1 match: silently stores it as sourceXmlPath.
 * - multiple matches: opens a quick chooser modal so the user picks.
 * - 0 matches: no-op with a notice (the plugin can still render from MD).
 */
export async function autoDetectXml(ctx: CommandsContext): Promise<string | null> {
  const all = ctx.app.vault.getFiles().filter((f) => f.extension === "timeline");
  if (!all.length) {
    new Notice("No .timeline file found in vault. The plugin can still render from Markdown.");
    return null;
  }
  const s = ctx.getSettings();
  if (all.length === 1) {
    s.sourceXmlPath = all[0].path;
    await ctx.saveSettings();
    new Notice(`Detected XML: ${all[0].path}`);
    return all[0].path;
  }
  // multiple — prompt
  const choice = await pickFromList(
    ctx.app,
    "Multiple .timeline files found — pick the one to sync with",
    all.map((f) => f.path)
  );
  if (!choice) return null;
  s.sourceXmlPath = choice;
  await ctx.saveSettings();
  new Notice(`Using XML: ${choice}`);
  return choice;
}

function pickFromList(app: App, title: string, items: string[]): Promise<string | null> {
  // Minimal native chooser: a one-shot Notice + Promise resolved via a modal-like
  // setup using FuzzySuggestModal isn't worth the dependency surface here.
  // Use SuggestModal-style: a temporary modal built from Obsidian's Modal.
  return new Promise((resolve) => {
    // Lazy import to avoid pulling Modal-related types into pure logic modules.
    import("obsidian").then(({ Modal, Setting }) => {
      const modal = new Modal(app);
      modal.titleEl.setText(title);
      let picked: string | null = null;
      for (const item of items) {
        new Setting(modal.contentEl)
          .setName(item)
          .addButton((b) =>
            b.setButtonText("Use").setCta().onClick(() => {
              picked = item;
              modal.close();
            })
          );
      }
      modal.onClose = () => resolve(picked);
      modal.open();
    });
  });
}

/**
 * Walks the metadataCache for every markdown file with `timeline.enabled: true`
 * in its frontmatter and infers the event notes directory + likely timeline id
 * from the longest common parent path. Updates settings and rebuilds caches.
 * Useful first-run action on iOS where you may already have the markdown notes
 * but no XML.
 */
export async function autoDetectEventNotes(
  ctx: CommandsContext
): Promise<void> {
  const matches: { path: string; id?: string }[] = [];
  for (const f of ctx.app.vault.getMarkdownFiles()) {
    const meta = ctx.app.metadataCache.getFileCache(f);
    const fm = meta?.frontmatter as Record<string, unknown> | undefined;
    if (!fm) continue;
    const tl = fm.timeline;
    if (!tl || typeof tl !== "object" || Array.isArray(tl)) continue;
    if ((tl as Record<string, unknown>).enabled !== true) continue;
    const id = (tl as Record<string, unknown>).id;
    matches.push({ path: f.path, id: typeof id === "string" ? id : undefined });
  }
  if (!matches.length) {
    new Notice("No timeline-enabled notes found in vault.");
    return;
  }
  const s = ctx.getSettings();
  const dir = longestCommonDir(matches.map((m) => m.path));
  if (dir) s.eventNotesDir = dir;
  // Pick most frequent timeline id.
  const idCounts = new Map<string, number>();
  for (const m of matches) {
    if (!m.id) continue;
    idCounts.set(m.id, (idCounts.get(m.id) ?? 0) + 1);
  }
  if (idCounts.size) {
    let best = "";
    let bestN = 0;
    for (const [id, n] of idCounts) {
      if (n > bestN) {
        best = id;
        bestN = n;
      }
    }
    if (best) s.timelineId = best;
  }
  await ctx.saveSettings();
  ctx.cache.resetIndex();
  ctx.cache.invalidateMdDoc();
  new Notice(
    `Detected ${matches.length} timeline note(s) in "${s.eventNotesDir}" (id: ${s.timelineId}).`
  );
}

async function writeBinary(
  ctx: CommandsContext,
  path: string,
  data: ArrayBuffer
): Promise<void> {
  await ctx.vault.writeBinary(path, data);
}

function longestCommonDir(paths: string[]): string {
  if (!paths.length) return "";
  const parts = paths.map((p) => p.split("/").slice(0, -1));
  let common: string[] = parts[0].slice();
  for (let i = 1; i < parts.length; i++) {
    const other = parts[i];
    let j = 0;
    while (j < common.length && j < other.length && common[j] === other[j]) j++;
    common = common.slice(0, j);
    if (!common.length) break;
  }
  return common.join("/");
}

/**
 * Schema-safe reimport. Used when the event-note layout has been bumped in a
 * way that older notes can't round-trip cleanly. Backs up the XML first (the
 * XML is the canonical source), removes every .md file in the event notes
 * directory, then re-runs importXml so the new notes match the current
 * schema. Updates lastImportSchemaVersion on success.
 */
export async function wipeAndReimport(ctx: CommandsContext): Promise<void> {
  const s = ctx.getSettings();
  if (!s.sourceXmlPath || !s.eventNotesDir) {
    throw new Error("Configure XML path and event notes directory first.");
  }
  if (!ctx.vault.exists(s.sourceXmlPath)) {
    throw new Error(`XML not found: ${s.sourceXmlPath}`);
  }
  // Long-running on big vaults — let the user know we started so they don't
  // wonder whether the button click did anything.
  new Notice("Starting wipe + reimport…", 4000);
  // Backup XML first — extra paranoia, the user could still recover.
  if (s.backupEnabled) {
    const bak = await ctx.vault.backup(s.sourceXmlPath);
    if (bak) {
      console.log("[Timeline XML Sync] pre-reimport backup:", bak);
      const pruned = await ctx.vault.pruneXmlBackups(
        s.sourceXmlPath,
        s.backupRetention
      );
      if (pruned > 0) console.log(`[Timeline XML Sync] pruned ${pruned} old XML backup(s)`);
    }
  }
  // Back up MD notes BEFORE deletion. Critical for the multi-device case:
  // another device may have created notes that haven't propagated to XML yet;
  // a stale-XML reimport would silently delete them otherwise.
  const mdBackup = await ctx.vault.backupFolder(s.eventNotesDir, "wipe");
  if (mdBackup) {
    new Notice(`Backed up MD notes to ${mdBackup}`, 6000);
    void ctx.appendSyncLog("wipe-backup", mdBackup, `from ${s.eventNotesDir}`);
    const prunedFolders = await ctx.vault.pruneFolderBackups(
      "wipe",
      s.backupRetention
    );
    if (prunedFolders > 0) {
      console.log(`[Timeline XML Sync] pruned ${prunedFolders} old MD backup folder(s)`);
    }
  }
  const files = ctx.vault.listMarkdownFiles(s.eventNotesDir);
  const filePaths = files.map((f) => f.path);
  let removed = 0;
  await ctx.withSelfWrite(async () => {
    for (const f of files) {
      await ctx.vault.deleteFile(f.path);
      removed++;
    }
  }, filePaths);
  await importXml(ctx);
  s.lastImportSchemaVersion = EVENT_NOTE_SCHEMA_VERSION;
  await ctx.saveSettings();
  new Notice(`Reimport complete — removed ${removed} old notes.`);
}

/** Check whether the on-disk notes were written by an older schema. */
export function needsSchemaReimport(s: TimelineXmlSyncSettings): boolean {
  return s.lastImportSchemaVersion < EVENT_NOTE_SCHEMA_VERSION;
}

export { shouldSkipNoteOverwrite, shouldAbortXmlWrite } from "./sync-policy";

function reportErr(e: unknown): void {
  console.error("[Timeline XML Sync]", e);
  new Notice(`Timeline XML Sync: ${(e as Error).message}`);
}

export async function importXml(ctx: CommandsContext): Promise<void> {
  const s = ctx.getSettings();
  if (!s.sourceXmlPath) throw new Error("Configure XML path in settings first.");
  if (!s.eventNotesDir)
    throw new Error("Configure event notes directory in settings first.");

  ctx.cache.invalidateXml(s.sourceXmlPath);
  const doc = await ctx.cache.getXml(s.sourceXmlPath);
  await ctx.vault.ensureFolder(s.eventNotesDir);

  // Source mtime stamped into every newly written note so future imports can
  // detect "this note was edited locally after we wrote it from XML" and skip
  // overwriting. Captured once here so all notes from this import share the
  // same baseline.
  const xmlMtime = ctx.vault.getMtime(s.sourceXmlPath);

  // Auto-populate category palette + knownCategories from the XML.
  ingestCategories(s, doc.categories);
  s.lastImportSchemaVersion = EVENT_NOTE_SCHEMA_VERSION;
  await ctx.saveSettings();

  const attachmentsDir = `${s.eventNotesDir}/_attachments`;
  let created = 0;
  let updated = 0;
  const skipped: string[] = [];
  const writtenPaths: string[] = [];
  await ctx.withSelfWrite(async () => {
    for (const ev of doc.events) {
      const path = `${s.eventNotesDir}/${ev.id}.md`;
      // Skip notes that have local edits made after the last XML-driven write.
      // Stamp check first — if the note never carried a stamp we treat it as
      // unknown and skip too (legacy notes; reset by `Wipe and reimport`).
      const onDisk = ctx.vault.getFile(path);
      if (onDisk) {
        try {
          const raw = await ctx.vault.readText(path);
          const parsed = parseEventNote(raw, {
            path,
            mirrorNames: s.mirrorNames,
          });
          if (
            shouldSkipNoteOverwrite(onDisk.stat.mtime, parsed.note?.lastSyncedXmlMtime)
          ) {
            skipped.push(path);
            continue;
          }
        } catch (e) {
          // Unparseable note — refuse to overwrite blindly.
          console.warn("[Timeline XML Sync] could not parse existing note", path, e);
          skipped.push(path);
          continue;
        }
      }
      // Picture sync (XML → MD): if the event carries a base64 icon, write
      // it to a vault attachment and put the path on the event.
      if (ev.icon && ev.icon.trim()) {
        try {
          const ext = guessImageExtension(ev.icon.trim());
          const attPath = `${attachmentsDir}/${ev.id}.${ext}`;
          await ctx.vault.ensureFolder(attachmentsDir);
          const bytes = base64ToArrayBuffer(ev.icon.trim());
          await writeBinary(ctx, attPath, bytes);
          ev.iconAttachmentPath = attPath;
        } catch (e) {
          console.warn("[Timeline XML Sync] icon write failed for", ev.id, e);
        }
      }
      const md = renderEventMarkdown(ev, {
        sourceXmlPath: s.sourceXmlPath,
        timelineId: s.timelineId,
        mirrorNames: s.mirrorNames,
        sourceMtime: xmlMtime,
      });
      const existed = !!onDisk;
      await ctx.vault.writeText(path, md);
      writtenPaths.push(path);
      if (existed) updated++;
      else created++;
    }
  }, writtenPaths);
  // Era notes — one Markdown file per <era>, written into _eras/ so they
  // sit next to but not mingled with the editable event notes. Same
  // newer-than-stamp guard as events: inspector edits aren't overwritten.
  let erasSkipped = 0;
  if (doc.eras && doc.eras.length) {
    const erasDir = `${s.eventNotesDir}/_eras`;
    await ctx.vault.ensureFolder(erasDir);
    const eraWrittenPaths: string[] = [];
    await ctx.withSelfWrite(async () => {
      for (const era of doc.eras!) {
        const path = `${erasDir}/${era.id}.md`;
        const onDisk = ctx.vault.getFile(path);
        if (onDisk) {
          try {
            const raw = await ctx.vault.readText(path);
            const parsed = (await import("../timeline/era-md")).parseEraNote(
              raw,
              era.id
            );
            if (
              shouldSkipNoteOverwrite(onDisk.stat.mtime, parsed?.lastSyncedXmlMtime)
            ) {
              erasSkipped++;
              skipped.push(path);
              continue;
            }
          } catch {
            erasSkipped++;
            skipped.push(path);
            continue;
          }
        }
        const md = renderEraMarkdown(era, s.timelineId, s.sourceXmlPath, xmlMtime);
        await ctx.vault.writeText(path, md);
        eraWrittenPaths.push(path);
      }
    }, []);
    void eraWrittenPaths; // reserved for future per-path self-write scoping
  }


  // Persist the XML mtime so external-change detection has a baseline.
  if (xmlMtime != null) {
    s.lastWrittenXmlMtime = xmlMtime;
    await ctx.saveSettings();
  }
  ctx.cache.resetIndex();
  if (skipped.length) {
    void ctx.appendSyncLog(
      "import-skipped",
      s.sourceXmlPath,
      `${skipped.length} note(s): ${skipped.slice(0, 10).join(", ")}${
        skipped.length > 10 ? " …" : ""
      }`
    );
    new Notice(
      `Timeline import: ${created} created, ${updated} updated, ${skipped.length} skipped (local edits). Use "Regenerate XML" to push, or "Wipe and reimport" to overwrite. See _logs/timeline-sync.log.`,
      10000
    );
  } else {
    new Notice(
      `Timeline import done — ${created} created, ${updated} updated, ${doc.events.length} total${
        doc.eras?.length ? `, ${doc.eras.length} era(s)` : ""
      }${erasSkipped ? `, ${erasSkipped} era(s) skipped` : ""}.`
    );
  }
}


function ingestCategories(
  s: TimelineXmlSyncSettings,
  categories: TimelineCategory[]
): void {
  const known = new Set(s.knownCategories);
  for (const c of categories) {
    if (!c.name) continue;
    known.add(c.name);
    if (!s.categoryColors[c.name] && c.color) {
      s.categoryColors[c.name] = normalizeColor(c.color);
    }
  }
  s.knownCategories = Array.from(known).sort();
}

function normalizeColor(raw: string): string {
  const m = raw.match(/^(\d+),(\d+),(\d+)$/);
  if (m) return `rgb(${m[1]},${m[2]},${m[3]})`;
  return raw;
}

export async function loadAllNotes(ctx: CommandsContext): Promise<{
  notes: EventNote[];
  errors: { path: string; message: string }[];
}> {
  const s = ctx.getSettings();
  const files = ctx.vault.listMarkdownFiles(s.eventNotesDir);
  const notes: EventNote[] = [];
  const errors: { path: string; message: string }[] = [];
  for (const f of files) {
    const raw = await ctx.vault.readText(f.path);
    const parsed = parseEventNote(raw, {
      path: f.path,
      mirrorNames: s.mirrorNames,
    });
    if (parsed.errors.length) {
      for (const m of parsed.errors) errors.push({ path: f.path, message: m });
    }
    if (parsed.note) notes.push(parsed.note);
  }
  return { notes, errors };
}

export async function validateNotes(ctx: CommandsContext): Promise<void> {
  const { notes, errors: parseErrors } = await loadAllNotes(ctx);
  const result = validateAll(notes);
  const all = [...parseErrors, ...result.errors];
  const lines = all.map((e) => `${e.path}: ${e.message}`);
  ctx.setDiagnostics(lines);
  if (lines.length === 0) {
    new Notice(`Timeline: all ${notes.length} event notes valid.`);
  } else {
    new Notice(
      `Timeline: ${lines.length} validation issue(s). Run "Open diagnostics" to view.`
    );
  }
}

export async function regenerateXml(ctx: CommandsContext): Promise<void> {
  const s = ctx.getSettings();
  if (!s.sourceXmlPath) throw new Error("Configure XML path in settings first.");

  // Snapshot mtime BEFORE we read anything. After merge, before write, we
  // re-read mtime and abort if it moved (and doesn't match what we last
  // wrote). Prevents the multi-device read-modify-write race: device A reads
  // the cache, Nextcloud lands device B's edit, device A overwrites.
  const baseMtime = ctx.vault.exists(s.sourceXmlPath)
    ? ctx.vault.getMtime(s.sourceXmlPath)
    : null;

  const { notes, errors: parseErrors } = await loadAllNotes(ctx);
  const result = validateAll(notes);
  const all = [...parseErrors, ...result.errors];
  if (all.length) {
    ctx.setDiagnostics(all.map((e) => `${e.path}: ${e.message}`));
    new Notice(
      `Timeline: refusing to write XML — ${all.length} validation issue(s).`
    );
    return;
  }

  let doc;
  if (ctx.vault.exists(s.sourceXmlPath)) {
    // Use the merged render doc so era edits made via the inspector (which
    // only write to the era MD note) propagate into the regenerated XML.
    doc = await ctx.cache.getRenderDoc();
  } else {
    doc = {
      version: "2.11.0",
      timetype: "gregoriantime",
      categories: [],
      events: [],
    };
  }

  // CAS check: did the XML change while we were reading + merging?
  if (ctx.vault.exists(s.sourceXmlPath)) {
    const now = ctx.vault.getMtime(s.sourceXmlPath);
    if (shouldAbortXmlWrite(baseMtime, now, s.lastWrittenXmlMtime)) {
      new Notice(
        "Timeline XML changed externally — refusing to overwrite. Run \"Import XML\" to pull remote changes, then \"Regenerate XML\" again.",
        10000
      );
      void ctx.appendSyncLog(
        "regen-aborted-external-change",
        s.sourceXmlPath,
        `base=${baseMtime} now=${now} lastWritten=${s.lastWrittenXmlMtime}`
      );
      return;
    }
  }

  if (s.backupEnabled && ctx.vault.exists(s.sourceXmlPath)) {
    const bak = await ctx.vault.backup(s.sourceXmlPath);
    if (bak) {
      console.log("[Timeline XML Sync] backup:", bak);
      const pruned = await ctx.vault.pruneXmlBackups(
        s.sourceXmlPath,
        s.backupRetention
      );
      if (pruned > 0) console.log(`[Timeline XML Sync] pruned ${pruned} XML backup(s)`);
    }
  }

  // Picture sync (MD → XML): for any event whose note carries an
  // `icon_path`, read the attachment back and base64-encode it into ev.icon.
  for (const n of notes) {
    const att = n.event.iconAttachmentPath;
    if (!att) continue;
    try {
      const buf = await ctx.vault.readBinary(att);
      n.event.icon = arrayBufferToBase64(buf);
    } catch (e) {
      console.warn(
        "[Timeline XML Sync] could not read icon attachment",
        att,
        e
      );
    }
  }

  const merged = mergeNotesIntoDoc(doc, notes);
  const xml = writeTimelineXml(merged);
  await ctx.withSelfWrite(async () => {
    await ctx.vault.writeText(s.sourceXmlPath, xml);
  }, [s.sourceXmlPath]);
  ctx.cache.invalidateXml(s.sourceXmlPath);
  // Stamp last-written mtime so external-change detection has a baseline.
  const writtenMtime = ctx.vault.getMtime(s.sourceXmlPath);
  if (writtenMtime != null) {
    s.lastWrittenXmlMtime = writtenMtime;
    await ctx.saveSettings();
  }
  new Notice(`Timeline XML regenerated — ${notes.length} events.`);
}

export async function openDiagnostics(ctx: CommandsContext): Promise<void> {
  // For now, just dump diagnostics into the developer console.
  // The settings tab also surfaces the latest list.
  console.log("[Timeline XML Sync] diagnostics:");
  console.log((ctx as unknown as { _diag?: string[] })._diag || []);
  new Notice("Timeline diagnostics printed to developer console.");
}

export async function rebuildIndex(ctx: CommandsContext): Promise<void> {
  // No persistent index yet — this is a placeholder that re-validates and
  // refreshes the in-memory diagnostics.
  await validateNotes(ctx);
  new Notice("Timeline index rebuilt.");
}
