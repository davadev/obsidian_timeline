import { Notice, type App, type Plugin, type TFile } from "obsidian";
import {
  EVENT_NOTE_SCHEMA_VERSION,
  resolveBackupFolder,
  type TimelineXmlSyncSettings,
} from "../settings";
import type { VaultAdapter } from "./vault-adapter";
import type { TemplateService } from "./template-service";
import type { TimelineCache } from "./cache";
import { writeTimelineXml } from "../timeline/xml-writer";
import { renderEventMarkdown } from "../timeline/markdown-writer";
import { parseEventNote } from "../timeline/markdown-parser";
import { logDebug, logDump, logError, logWarn } from "../logger";
import { contentFingerprint } from "./sync-policy";
import { safeFileName } from "../timeline/id-utils";
import { findEraNotePath } from "./era-files";
import { eventSourceKey } from "../timeline/event-source";
import { validateAll } from "../timeline/validator";
import { mergeNotesIntoDoc } from "../timeline/sync-engine";
import type { EventNote, TimelineCategory, TimelineEvent } from "../timeline/model";
import {
  classifyExternalXml,
  isUntouched,
  shouldSkipImportOverwrite,
  withContentHash,
  shouldAbortXmlWrite,
} from "./sync-policy";
import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  guessImageExtension,
} from "../timeline/base64";
import { parseEraNote, renderEraMarkdown } from "../timeline/era-md";
import { parseTimelineMetaNote, renderTimelineMetaNote } from "../timeline/meta-note";

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
  /** The diagnostics last stored by `setDiagnostics`. */
  getDiagnostics: () => string[];
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
    callback: () => openDiagnostics(ctx),
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
    void import("obsidian").then(({ Modal, Setting }) => {
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
    const fm = meta?.frontmatter;
    if (!fm) continue;
    const tl: unknown = fm.timeline;
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
    s.timelineId = best;
  }
  await ctx.saveSettings();
  ctx.cache.resetIndex();
  ctx.cache.invalidateMdDoc();
  new Notice(
    `Detected ${matches.length} timeline note(s) in "${s.eventNotesDir}" (id: ${s.timelineId}).`
  );
}

/** Longest folder shared by every path ("" when they have none in common). */
function longestCommonDir(paths: string[]): string {
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
  // Read the XML BEFORE anything is deleted. An unreadable file (half-synced,
  // hand-broken) would otherwise throw from the import below, after the notes
  // were already gone. An XML with no events would wipe the notes and bring
  // nothing back.
  ctx.cache.invalidateXml(s.sourceXmlPath);
  const xmlDoc = await ctx.cache.getXml(s.sourceXmlPath);
  if (!xmlDoc.events.length) {
    throw new Error(
      "The XML has no events — nothing to reimport, so the notes were left alone."
    );
  }
  // Long-running on big vaults — let the user know we started so they don't
  // wonder whether the button click did anything.
  new Notice("Starting wipe + reimport…", 4000);
  // Backup XML first — extra paranoia, the user could still recover.
  if (s.backupEnabled) {
    const bak = await ctx.vault.backup(s.sourceXmlPath);
    if (bak) {
      logDebug("pre-reimport backup:", bak);
      const pruned = await ctx.vault.pruneXmlBackups(
        s.sourceXmlPath,
        s.backupRetention
      );
      if (pruned > 0) logDebug(`pruned ${pruned} old XML backup(s)`);
    }
  }
  // Back up MD notes BEFORE deletion. Critical for the multi-device case:
  // another device may have created notes that haven't propagated to XML yet;
  // a stale-XML reimport would silently delete them otherwise.
  const backupRoot = resolveBackupFolder(s);
  const mdBackup = await ctx.vault.backupFolder(s.eventNotesDir, "wipe", backupRoot);
  if (mdBackup) {
    new Notice(`Backed up MD notes to ${mdBackup}`, 6000);
    void ctx.appendSyncLog("wipe-backup", mdBackup, `from ${s.eventNotesDir}`);
    const prunedFolders = await ctx.vault.pruneFolderBackups(
      "wipe",
      s.backupRetention,
      backupRoot
    );
    if (prunedFolders > 0) {
      logDebug(`pruned ${prunedFolders} old MD backup folder(s)`);
    }
  }
  // Not the backups: the snapshot just taken lives under the notes folder by
  // default, and deleting it would defeat the point of taking it.
  // Only the notes this plugin owns (events, eras, the metadata note): the
  // folder may also hold the user's own pages, which were never ours to wipe.
  const files: TFile[] = [];
  for (const f of ctx.vault.listMarkdownFiles(s.eventNotesDir, backupRoot)) {
    try {
      const raw = await ctx.vault.readText(f.path);
      const ours =
        parseEventNote(raw, { path: f.path, mirrorNames: s.mirrorNames }).note ||
        parseEraNote(raw, f.basename) ||
        parseTimelineMetaNote(raw);
      if (ours) files.push(f);
    } catch (e) {
      logWarn("could not read note for wipe, leaving it", f.path, e);
    }
  }
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

function reportErr(e: unknown): void {
  logError(e);
  new Notice(`Timeline XML Sync: ${(e as Error).message}`);
}

export async function importXml(ctx: CommandsContext): Promise<void> {
  const s = ctx.getSettings();
  if (!s.sourceXmlPath) throw new Error("Configure XML path in settings first.");
  if (!s.eventNotesDir)
    throw new Error("Configure event notes directory in settings first.");

  // Baseline taken BEFORE the XML is read: if a sync client lands a newer
  // file while the import runs, the recorded baseline is the older one, so the
  // next regenerate sees the XML as changed and asks for another import, rather
  // than treating notes built from the old content as current.
  // Source mtime stamped into every newly written note so future imports can
  // detect "this note was edited locally after we wrote it from XML" and skip
  // overwriting. Captured once here so all notes from this import share the
  // same baseline.
  const xmlMtime = ctx.vault.getMtime(s.sourceXmlPath);
  let baselineFingerprint: string | null;
  try {
    baselineFingerprint = contentFingerprint(await ctx.vault.readText(s.sourceXmlPath));
  } catch {
    baselineFingerprint = null;
  }
  ctx.cache.invalidateXml(s.sourceXmlPath);
  const doc = await ctx.cache.getXml(s.sourceXmlPath);
  await ctx.vault.ensureFolder(s.eventNotesDir);

  // Auto-populate category palette + knownCategories from the XML.
  ingestCategories(s, doc.categories);
  s.lastImportSchemaVersion = EVENT_NOTE_SCHEMA_VERSION;
  await ctx.saveSettings();

  const attachmentsDir = `${s.eventNotesDir}/_attachments`;
  let created = 0;
  let updated = 0;
  const skipped: string[] = [];
  const conflicts: string[] = [];
  const claimedPaths = new Map<string, string>();
  const writtenPaths: string[] = [];
  await ctx.withSelfWrite(async () => {
    for (const ev of doc.events) {
      // The note may have been renamed or moved since it was written: look it
      // up by event id before assuming the default file name, or the import
      // writes a second note with the same id and regenerate then refuses
      // ("duplicate event_id") until one is deleted by hand.
      const path = await pickNotePath(ctx, ev.id, claimedPaths);
      // Skip notes that have local edits made after the last XML-driven write.
      // Stamp check first — if the note never carried a stamp we treat it as
      // unknown and skip too (legacy notes; reset by `Wipe and reimport`).
      const onDisk = ctx.vault.getFile(path);
      let existingRaw: string | undefined;
      if (onDisk) {
        try {
          const raw = await ctx.vault.readText(path);
          existingRaw = raw;
          const parsed = parseEventNote(raw, {
            path,
            mirrorNames: s.mirrorNames,
          });
          if (
            shouldSkipImportOverwrite(raw, onDisk.stat.mtime, parsed.note?.lastSyncedXmlMtime)
          ) {
            skipped.push(path);
            // Edited here AND changed in the XML since the note was written?
            // The note records the XML content it was copied from.
            const base = parsed.note?.extraFrontmatter.timeline_src;
            if (typeof base === "string" && base !== sourceFingerprint(ev)) {
              conflicts.push(path);
            }
            continue;
          }
        } catch (e) {
          // Unparseable note — refuse to overwrite blindly.
          logWarn("could not parse existing note", path, e);
          skipped.push(path);
          continue;
        }
      }
      // Picture sync (XML → MD): if the event carries a base64 icon, write
      // it to a vault attachment and put the path on the event.
      if (ev.icon && ev.icon.trim()) {
        try {
          const ext = guessImageExtension(ev.icon.trim());
          const attPath = `${attachmentsDir}/${safeFileName(ev.id)}.${ext}`;
          await ctx.vault.ensureFolder(attachmentsDir);
          const bytes = base64ToArrayBuffer(ev.icon.trim());
          await ctx.vault.writeBinary(attPath, bytes);
          ev.iconAttachmentPath = attPath;
        } catch (e) {
          logWarn("icon write failed for", ev.id, e);
        }
      }
      const md = withContentHash(
        renderEventMarkdown(ev, {
          sourceXmlPath: s.sourceXmlPath,
          timelineId: s.timelineId,
          mirrorNames: s.mirrorNames,
          sourceMtime: xmlMtime,
          trimDescription: s.trimDescriptionOnWrite,
          extraFrontmatter: { timeline_src: sourceFingerprint(ev) },
        })
      );
      // Same text as what is there: leave the file alone, so sync clients
      // have nothing to upload and no other device sees a change.
      if (existingRaw === md) continue;
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
  const eras = doc.eras ?? [];
  if (eras.length) {
    const erasDir = `${s.eventNotesDir}/_eras`;
    await ctx.vault.ensureFolder(erasDir);
    await ctx.withSelfWrite(async () => {
      for (const era of eras) {
        const path =
          (await findEraNotePath(ctx.vault, s, era.id)) ??
          `${erasDir}/${era.id}.md`;
        const onDisk = ctx.vault.getFile(path);
        let existingRaw: string | undefined;
        if (onDisk) {
          try {
            const raw = await ctx.vault.readText(path);
            existingRaw = raw;
            const parsed = parseEraNote(raw, era.id);
            if (
              shouldSkipImportOverwrite(raw, onDisk.stat.mtime, parsed?.lastSyncedXmlMtime)
            ) {
              skipped.push(path);
              continue;
            }
          } catch {
            skipped.push(path);
            continue;
          }
        }
        const md = withContentHash(
          renderEraMarkdown(era, s.timelineId, s.sourceXmlPath, xmlMtime)
        );
        if (existingRaw === md) continue;
        await ctx.vault.writeText(path, md);
      }
    });
  }

  const metaDir = `${s.eventNotesDir}/_timeline`;
  const metaPath = `${metaDir}/timeline-metadata.md`;
  await ctx.vault.ensureFolder(metaDir);
  const onDiskMeta = ctx.vault.getFile(metaPath);
  let skipMeta = false;
  let existingMeta: string | undefined;
  if (onDiskMeta) {
    try {
      const raw = await ctx.vault.readText(metaPath);
      existingMeta = raw;
      const parsed = parseTimelineMetaNote(raw);
      if (shouldSkipImportOverwrite(raw, onDiskMeta.stat.mtime, parsed?.lastSyncedXmlMtime)) {
        skipMeta = true;
        skipped.push(metaPath);
      }
    } catch {
      skipMeta = true;
      skipped.push(metaPath);
    }
  }
  if (!skipMeta) {
    const metaMd = withContentHash(
      renderTimelineMetaNote(doc, s.sourceXmlPath, xmlMtime)
    );
    if (existingMeta !== metaMd) {
      await ctx.withSelfWrite(async () => {
        await ctx.vault.writeText(metaPath, metaMd);
      }, [metaPath]);
    }
  }

  // An event the parser could not read is still in the XML: its note is not an
  // orphan, whatever is wrong with its dates.
  const unreadableIds = (doc.unparsedEvents ?? []).flatMap((n) => {
    const id = (n as { ":@"?: Record<string, string> })[":@"]?.["@_id"];
    return id ? [id] : [];
  });
  const removed = await removeOrphanNotes(ctx, [
    ...doc.events.map((e) => e.id),
    ...unreadableIds,
  ]);

  // Persist the XML mtime and fingerprint so external-change detection has a
  // baseline for both "when" and "what".
  if (xmlMtime != null) s.lastWrittenXmlMtime = xmlMtime;
  s.lastSeenXmlFingerprint = baselineFingerprint;
  await ctx.saveSettings();
  ctx.cache.resetIndex();
  if (conflicts.length) {
    ctx.setDiagnostics(
      conflicts.map(
        (p) =>
          `${p}: edited here and changed in the XML since — the next "Regenerate XML" keeps this note's version and drops the XML's`
      )
    );
    void ctx.appendSyncLog(
      "import-conflict",
      s.sourceXmlPath,
      `${conflicts.length} note(s): ${conflicts.slice(0, 10).join(", ")}${conflicts.length > 10 ? " …" : ""}`
    );
  }
  if (skipped.length) {
    void ctx.appendSyncLog(
      "import-skipped",
      s.sourceXmlPath,
      `${skipped.length} note(s): ${skipped.slice(0, 10).join(", ")}${
        skipped.length > 10 ? " …" : ""
      }`
    );
    new Notice(
      `Timeline import: ${created} created, ${updated} updated, ${skipped.length} skipped (local edits)${conflictNote(conflicts.length)}${removedNote(removed)}. Use "Regenerate XML" to push, or "Wipe and reimport" to overwrite. See the sync log.`,
      10000
    );
  } else {
    new Notice(
      `Timeline import done — ${created} created, ${updated} updated, ${doc.events.length} total${
        eras.length ? `, ${eras.length} era(s)` : ""
      }${removedNote(removed)}.`
    );
  }
}

function conflictNote(n: number): string {
  return n
    ? `, ${n} of them also changed in the XML (conflict: see "Open diagnostics")`
    : "";
}

function sourceFingerprint(ev: TimelineEvent): string {
  return contentFingerprint(eventSourceKey(ev));
}

/**
 * Where an event's note goes. A note already indexed under the event id wins
 * (it may have been renamed). Otherwise the default file name, moving to
 * `-2`, `-3` ... when that name already belongs to a different event, or was
 * just taken by another event in this very import (two XML ids can sanitise to
 * the same name), so one never overwrites the other.
 */
async function pickNotePath(
  ctx: CommandsContext,
  id: string,
  claimed: Map<string, string>
): Promise<string> {
  const known = ctx.cache.resolvePath(id);
  if (known) {
    claimed.set(known, id);
    return known;
  }
  const base = `${ctx.getSettings().eventNotesDir}/${safeFileName(id)}`;
  for (let n = 1; ; n++) {
    const path = n === 1 ? `${base}.md` : `${base}-${n}.md`;
    const owner = claimed.get(path);
    if (owner !== undefined && owner !== id) continue;
    if (owner === undefined && ctx.vault.getFile(path)) {
      try {
        const other = parseEventNote(await ctx.vault.readText(path), {
          path,
          mirrorNames: ctx.getSettings().mirrorNames,
        }).note;
        if (other && other.event.id !== id) continue;
      } catch {
        // unreadable: leave it to the skip logic in the caller
      }
    }
    claimed.set(path, id);
    return path;
  }
}

function removedNote(removed: number): string {
  return removed ? `, ${removed} removed (deleted in the XML)` : "";
}

/**
 * Event notes whose event is gone from the XML. Left alone, the next
 * regenerate would write them straight back and an event deleted in Timeline
 * Project would reappear. Only notes that still carry the plugin's seal intact
 * are removed (nobody has edited them, so nothing is lost), and they go through
 * the trash. A XML with no events at all removes nothing: an empty or
 * half-synced file must not empty the notes folder.
 */
async function removeOrphanNotes(
  ctx: CommandsContext,
  xmlIds: string[]
): Promise<number> {
  if (!xmlIds.length) return 0;
  const s = ctx.getSettings();
  const ids = new Set(xmlIds);
  const orphans: string[] = [];
  for (const f of ctx.vault.listMarkdownFiles(s.eventNotesDir, resolveBackupFolder(s))) {
    try {
      const raw = await ctx.vault.readText(f.path);
      if (isUntouched(raw) !== true) continue;
      const note = parseEventNote(raw, { path: f.path, mirrorNames: s.mirrorNames }).note;
      if (note && !ids.has(note.event.id)) orphans.push(f.path);
    } catch (e) {
      logWarn("could not check note for removal", f.path, e);
    }
  }
  if (!orphans.length) return 0;
  await ctx.withSelfWrite(async () => {
    for (const p of orphans) await ctx.vault.deleteFile(p);
  }, orphans);
  void ctx.appendSyncLog(
    "import-removed",
    s.sourceXmlPath,
    `${orphans.length} note(s): ${orphans.slice(0, 10).join(", ")}${orphans.length > 10 ? " …" : ""}`
  );
  return orphans.length;
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
  metaPatch?: Partial<import("../timeline/model").TimelineDoc>;
  metaStamp?: number;
  errors: { path: string; message: string }[];
}> {
  const s = ctx.getSettings();
  const files = ctx.vault.listMarkdownFiles(
    s.eventNotesDir,
    resolveBackupFolder(s)
  );
  const notes: EventNote[] = [];
  const eras: import("../timeline/model").TimelineEra[] = [];
  let metaPatch: Partial<import("../timeline/model").TimelineDoc> | undefined;
  let metaStamp: number | undefined;
  const errors: { path: string; message: string }[] = [];
  for (const f of files) {
    const raw = await ctx.vault.readText(f.path);
    const meta = parseTimelineMetaNote(raw);
    if (meta) {
      metaPatch = meta.docPatch;
      metaStamp = meta.lastSyncedXmlMtime;
      continue;
    }
    const era = parseEraNote(raw, f.basename);
    if (era) {
      eras.push(era);
      continue;
    }
    const parsed = parseEventNote(raw, {
      path: f.path,
      mirrorNames: s.mirrorNames,
    });
    if (parsed.errors.length) {
      for (const m of parsed.errors) errors.push({ path: f.path, message: m });
    }
    if (parsed.note) notes.push(parsed.note);
  }
  if (eras.length) {
    metaPatch = { ...(metaPatch ?? {}), eras };
  }
  return { notes, metaPatch, metaStamp, errors };
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

  // The XML moved on since our last import or write (saved in Timeline
  // Project, or landed from another device): the notes are then older than it,
  // and writing them over it would silently undo that edit. Import first; that
  // updates the untouched notes and keeps the edited ones.
  if (baseMtime != null && (await xmlChangedSinceLastSync(ctx, baseMtime))) {
    new Notice(
      "Timeline XML changed since the last import — refusing to overwrite it. Run \"import XML\" to pull those changes, then \"regenerate XML\" again.",
      10000
    );
    void ctx.appendSyncLog(
      "regen-aborted-xml-newer",
      s.sourceXmlPath,
      `mtime=${baseMtime} lastWritten=${s.lastWrittenXmlMtime}`
    );
    return;
  }

  const { notes, metaPatch, metaStamp, errors: parseErrors } = await loadAllNotes(ctx);
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
    // Always use the parsed XML as the merge baseline so unknown XML fields
    // and attributes survive regeneration.
    doc = await ctx.cache.getXml(s.sourceXmlPath);
  } else {
    doc = {
      version: "2.11.0",
      timetype: "gregoriantime",
      categories: [],
      events: [],
    };
  }

  // An empty notes folder next to a XML full of events is a folder that has
  // not synced in yet (iCloud, Nextcloud) or was emptied by accident, not an
  // intention to delete the timeline. Writing now would erase every event.
  if (doc.events.length > 0 && notes.length === 0) {
    new Notice(
      "Timeline: no event notes found — refusing to write an empty XML over a timeline that has events. Check the event notes folder, or run \"import XML\".",
      10000
    );
    void ctx.appendSyncLog(
      "regen-aborted-no-notes",
      s.sourceXmlPath,
      `xmlEvents=${doc.events.length} notes=0`
    );
    return;
  }

  // CAS check: did the XML change while we were reading + merging?
  if (ctx.vault.exists(s.sourceXmlPath)) {
    const now = ctx.vault.getMtime(s.sourceXmlPath);
    if (shouldAbortXmlWrite(baseMtime, now, s.lastWrittenXmlMtime)) {
      new Notice(
        "Timeline XML changed externally — refusing to overwrite. Run \"import XML\" to pull remote changes, then \"regenerate XML\" again.",
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
    // The XML exists (checked above), so a backup path always comes back.
    logDebug("backup:", await ctx.vault.backup(s.sourceXmlPath));
    const pruned = await ctx.vault.pruneXmlBackups(
      s.sourceXmlPath,
      s.backupRetention
    );
    if (pruned > 0) logDebug(`pruned ${pruned} XML backup(s)`);
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
      logWarn("could not read icon attachment", att, e);
    }
  }

  const merged = mergeNotesIntoDoc(doc, notes);
  if (metaPatch) {
    // Stale meta-note guard: when the meta note's stamp is older than the
    // current XML mtime, the XML has remote edits the meta note doesn't know
    // about. Skip overwriting categories/eras/view to avoid clobbering them.
    // Era edits done via the inspector still propagate because they live in
    // their own _eras/<id>.md notes (no stamp dependency there).
    const xmlNow = ctx.vault.getMtime(s.sourceXmlPath);
    // The XML's own mtime moves every time WE regenerate it, so compare with
    // the later of the import stamp and our last write; only a newer file is
    // somebody else's edit.
    const metaStale =
      metaStamp != null &&
      xmlNow != null &&
      xmlNow > Math.max(metaStamp, s.lastWrittenXmlMtime ?? 0) + 2000;
    if (metaStale) {
      new Notice(
        "Timeline metadata note is older than the XML — keeping XML's categories/eras/view. Run \"import XML\" to refresh the metadata note.",
        10000
      );
      void ctx.appendSyncLog(
        "meta-stale-skip",
        `${s.eventNotesDir}/_timeline/timeline-metadata.md`,
        `metaStamp=${metaStamp} xmlMtime=${xmlNow}`
      );
      // A metadata patch always carries an era list (possibly empty).
      merged.eras = metaPatch.eras;
    } else {
      merged.version = metaPatch.version ?? merged.version;
      merged.timetype = metaPatch.timetype ?? merged.timetype;
      if (metaPatch.categories) merged.categories = metaPatch.categories;
      merged.eras = metaPatch.eras;
      if (metaPatch.view) merged.view = metaPatch.view;
    }
  }
  const xml = writeTimelineXml(merged);
  // Nothing changed: leave the file (and its mtime) alone. Rewriting identical
  // bytes would make every other device see an "external change".
  if (
    ctx.vault.exists(s.sourceXmlPath) &&
    (await ctx.vault.readText(s.sourceXmlPath)) === xml
  ) {
    new Notice(`Timeline XML already up to date — ${notes.length} events.`);
    return;
  }
  await ctx.withSelfWrite(async () => {
    await ctx.vault.writeText(s.sourceXmlPath, xml);
  }, [s.sourceXmlPath]);
  ctx.cache.invalidateXml(s.sourceXmlPath);
  // Stamp mtime AND a fingerprint of what we wrote, so a sync client that
  // later re-downloads the same bytes is recognised as a touch rather than
  // reported as somebody else's edit.
  const writtenMtime = ctx.vault.getMtime(s.sourceXmlPath);
  s.lastSeenXmlFingerprint = contentFingerprint(xml);
  if (writtenMtime != null) s.lastWrittenXmlMtime = writtenMtime;
  await ctx.saveSettings();
  new Notice(`Timeline XML regenerated — ${notes.length} events.`);
}

async function xmlChangedSinceLastSync(
  ctx: CommandsContext,
  mtime: number
): Promise<boolean> {
  const s = ctx.getSettings();
  const first = classifyExternalXml({ mtime, lastWrittenMtime: s.lastWrittenXmlMtime });
  if (first.kind !== "changed") return false;
  // The timestamp moved: only different bytes count (sync clients touch files).
  let fingerprint: string | null = null;
  try {
    fingerprint = contentFingerprint(await ctx.vault.readText(s.sourceXmlPath));
  } catch {
    return true; // cannot tell; do not overwrite
  }
  const verdict = classifyExternalXml({
    mtime,
    lastWrittenMtime: s.lastWrittenXmlMtime,
    fingerprint,
    lastFingerprint: s.lastSeenXmlFingerprint,
  });
  return verdict.kind === "changed";
}

export function openDiagnostics(ctx: CommandsContext): void {
  // Printing to the console IS this command: the user explicitly asked for a
  // dump they can copy into a bug report. The settings tab shows the same
  // list. Not gated on logLevel for that reason.
  logDump("diagnostics:", ctx.getDiagnostics());
  new Notice("Timeline diagnostics printed to the developer console (verbose).");
}

export async function rebuildIndex(ctx: CommandsContext): Promise<void> {
  // No persistent index yet — this is a placeholder that re-validates and
  // refreshes the in-memory diagnostics.
  await validateNotes(ctx);
  new Notice("Timeline index rebuilt.");
}
