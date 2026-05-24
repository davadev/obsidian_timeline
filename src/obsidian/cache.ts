import {
  TFile,
  type App,
  type CachedMetadata,
  type MetadataCache,
  type Vault,
} from "obsidian";
import { parseTimelineXml } from "../timeline/xml-parser";
import type { TimelineDoc } from "../timeline/model";
import type { TimelineXmlSyncSettings } from "../settings";

/**
 * Process-wide caches. The post-processor and commands hit these instead of
 * re-reading + re-parsing on every invocation.
 *
 * - `xml`: parsed TimelineDoc keyed by path, invalidated by mtime change.
 * - `idToPath`: event_id → note path map, built lazily from the Obsidian
 *   metadataCache (no YAML reparse) and kept incrementally up to date by the
 *   plugin's file event handlers.
 */
export class TimelineCache {
  private xml = new Map<string, { mtime: number; doc: TimelineDoc }>();
  private idToPath = new Map<string, string>();
  private pathToId = new Map<string, string>();
  private indexBuilt = false;

  constructor(
    private app: App,
    private getSettings: () => TimelineXmlSyncSettings
  ) {}

  private get vault(): Vault {
    return this.app.vault;
  }

  private get meta(): MetadataCache {
    return this.app.metadataCache;
  }

  async getXml(path: string): Promise<TimelineDoc> {
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`XML not found: ${path}`);
    const cached = this.xml.get(path);
    if (cached && cached.mtime === file.stat.mtime) return cached.doc;
    const raw = await this.vault.read(file);
    const doc = parseTimelineXml(raw);
    this.xml.set(path, { mtime: file.stat.mtime, doc });
    return doc;
  }

  invalidateXml(path?: string): void {
    if (path == null) this.xml.clear();
    else this.xml.delete(path);
  }

  /**
   * Pull event_id from frontmatter via Obsidian's metadataCache — avoids
   * the cost of fully re-parsing the file's YAML on every render.
   */
  private readEventId(meta: CachedMetadata | null): string | null {
    if (!meta?.frontmatter) return null;
    const fm = meta.frontmatter as Record<string, unknown>;
    const s = this.getSettings();
    // Prefer mirror prop (top-level scalar — fastest lookup).
    const mirror = fm[s.mirrorNames.eventId];
    if (typeof mirror === "string" && mirror) return mirror;
    // Fall back to nested timeline.event_id.
    const tl = fm.timeline;
    if (tl && typeof tl === "object" && !Array.isArray(tl)) {
      const id = (tl as Record<string, unknown>).event_id;
      if (typeof id === "string" && id) return id;
    }
    return null;
  }

  /** Build the full id↔path index from metadataCache. Idempotent. */
  buildIndex(): void {
    if (this.indexBuilt) return;
    this.idToPath.clear();
    this.pathToId.clear();
    const dir = this.getSettings().eventNotesDir;
    if (!dir) {
      this.indexBuilt = true;
      return;
    }
    for (const f of this.vault.getMarkdownFiles()) {
      if (f.path !== dir && !f.path.startsWith(dir + "/")) continue;
      const id = this.readEventId(this.meta.getFileCache(f));
      if (id) {
        this.idToPath.set(id, f.path);
        this.pathToId.set(f.path, id);
      }
    }
    this.indexBuilt = true;
  }

  resolvePath(id: string): string | null {
    if (!this.indexBuilt) this.buildIndex();
    return this.idToPath.get(id) ?? null;
  }

  /** Update index for one file (called on vault create/modify/rename). */
  updateFile(path: string): void {
    if (!this.indexBuilt) return;
    const dir = this.getSettings().eventNotesDir;
    if (!dir) return;
    if (path !== dir && !path.startsWith(dir + "/")) return;
    const f = this.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return;
    const prevId = this.pathToId.get(path);
    if (prevId) this.idToPath.delete(prevId);
    const newId = this.readEventId(this.meta.getFileCache(f));
    if (newId) {
      this.idToPath.set(newId, path);
      this.pathToId.set(path, newId);
    } else {
      this.pathToId.delete(path);
    }
  }

  /** Remove a path from the index (called on delete/rename-old). */
  removeFile(path: string): void {
    if (!this.indexBuilt) return;
    const prevId = this.pathToId.get(path);
    if (prevId) this.idToPath.delete(prevId);
    this.pathToId.delete(path);
  }

  /** Drop everything — e.g. when eventNotesDir setting changes. */
  resetIndex(): void {
    this.indexBuilt = false;
    this.idToPath.clear();
    this.pathToId.clear();
  }
}
