import { Notice, type App, type Plugin } from "obsidian";
import type { TimelineXmlSyncSettings } from "../settings";
import type { VaultAdapter } from "./vault-adapter";
import type { TemplateService } from "./template-service";
import { parseTimelineXml } from "../timeline/xml-parser";
import { writeTimelineXml } from "../timeline/xml-writer";
import { renderEventMarkdown } from "../timeline/markdown-writer";
import { parseEventNote } from "../timeline/markdown-parser";
import { validateAll } from "../timeline/validator";
import { mergeNotesIntoDoc } from "../timeline/sync-engine";
import type { EventNote } from "../timeline/model";

export interface CommandsContext {
  app: App;
  plugin: Plugin;
  vault: VaultAdapter;
  templates: TemplateService;
  getSettings: () => TimelineXmlSyncSettings;
  /** Suppress sync loop while plugin itself writes files. */
  withSelfWrite: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Replace stored diagnostics. */
  setDiagnostics: (lines: string[]) => void;
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
    name: "Create new timeline event note",
    callback: () =>
      ctx.templates
        .createNewEventNote("New timeline event")
        .then((p) => new Notice(`Created: ${p}`))
        .catch(reportErr),
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
}

function reportErr(e: unknown): void {
  console.error("[Timeline XML Sync]", e);
  new Notice(`Timeline XML Sync: ${(e as Error).message}`);
}

export async function importXml(ctx: CommandsContext): Promise<void> {
  const s = ctx.getSettings();
  if (!s.sourceXmlPath) throw new Error("Configure XML path in settings first.");
  if (!s.eventNotesDir)
    throw new Error("Configure event notes directory in settings first.");

  const xml = await ctx.vault.readText(s.sourceXmlPath);
  const doc = parseTimelineXml(xml);
  await ctx.vault.ensureFolder(s.eventNotesDir);

  let created = 0;
  let updated = 0;
  await ctx.withSelfWrite(async () => {
    for (const ev of doc.events) {
      const md = renderEventMarkdown(ev, {
        sourceXmlPath: s.sourceXmlPath,
        timelineId: s.timelineId,
        mirrorNames: s.mirrorNames,
      });
      const path = `${s.eventNotesDir}/${ev.id}.md`;
      const existed = ctx.vault.exists(path);
      await ctx.vault.writeText(path, md);
      if (existed) updated++;
      else created++;
    }
  });
  new Notice(
    `Timeline import done — ${created} created, ${updated} updated, ${doc.events.length} total.`
  );
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
    const oldXml = await ctx.vault.readText(s.sourceXmlPath);
    doc = parseTimelineXml(oldXml);
  } else {
    doc = {
      version: "2.11.0",
      timetype: "gregoriantime",
      categories: [],
      events: [],
    };
  }

  if (s.backupEnabled && ctx.vault.exists(s.sourceXmlPath)) {
    const bak = await ctx.vault.backup(s.sourceXmlPath);
    if (bak) console.log("[Timeline XML Sync] backup:", bak);
  }

  const merged = mergeNotesIntoDoc(doc, notes);
  const xml = writeTimelineXml(merged);
  await ctx.withSelfWrite(async () => {
    await ctx.vault.writeText(s.sourceXmlPath, xml);
  });
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
