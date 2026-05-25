import {
  TFile,
  type App,
  type CachedMetadata,
  type MetadataCache,
  type Vault,
} from "obsidian";
import { parseTimelineXml } from "../timeline/xml-parser";
import { parseEventNote } from "../timeline/markdown-parser";
import type { TimelineCategory, TimelineDoc, TimelineEvent } from "../timeline/model";
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
    this.mdDoc = null;
    this.mdDocBuiltAt = 0;
  }

  /**
   * Build a TimelineDoc-like value from Markdown notes in the event dir.
   * Cached for `MD_DOC_TTL_MS` so a render burst doesn't re-read every file.
   */
  private mdDoc: TimelineDoc | null = null;
  private mdDocBuiltAt = 0;

  async getMdDoc(): Promise<TimelineDoc> {
    const now = Date.now();
    if (this.mdDoc && now - this.mdDocBuiltAt < MD_DOC_TTL_MS) return this.mdDoc;
    const s = this.getSettings();
    const dir = s.eventNotesDir;
    const events: TimelineEvent[] = [];
    const categories = new Map<string, TimelineCategory>();
    if (dir) {
      const files = this.vault.getMarkdownFiles().filter(
        (f) => f.path === dir || f.path.startsWith(dir + "/")
      );
      // Yield to the UI every BATCH files so we never block the main thread
      // for long on iOS / large vaults.
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        try {
          const raw = await this.vault.cachedRead(f);
          const p = parseEventNote(raw, { path: f.path, mirrorNames: s.mirrorNames });
          if (p.note) {
            events.push(p.note.event);
            const cat = p.note.event.category;
            if (cat && !categories.has(cat)) {
              categories.set(cat, { name: cat, color: s.categoryColors[cat] });
            }
          }
        } catch {
          // skip unreadable files
        }
        if ((i + 1) % BATCH === 0) await yieldToUi();
      }
    }
    this.mdDoc = {
      version: "md",
      timetype: "gregoriantime",
      categories: Array.from(categories.values()),
      events,
    };
    this.mdDocBuiltAt = now;
    return this.mdDoc;
  }

  invalidateMdDoc(): void {
    this.mdDoc = null;
    this.mdDocBuiltAt = 0;
  }

  /**
   * Single entry point used by the render paths (inline blocks, global view,
   * export). Honours `eventSource`:
   *
   * - "xml": only the XML.
   * - "md": only the Markdown notes.
   * - "auto": XML if available, with Markdown events overlaid — MD wins for
   *   any matching `event_id` and brand-new MD events get appended. This is
   *   what makes a freshly-created note visible in the global view + render
   *   blocks before the user has run a manual XML regenerate.
   */
  async getRenderDoc(): Promise<TimelineDoc> {
    const s = this.getSettings();
    const xmlPath = s.sourceXmlPath;
    const xmlAvailable = !!xmlPath && this.vault.getAbstractFileByPath(xmlPath) !== null;
    if (s.eventSource === "xml") {
      if (!xmlAvailable) throw new Error(`XML not found: ${xmlPath}`);
      return this.getXml(xmlPath);
    }
    if (s.eventSource === "md") return this.getMdDoc();
    // auto
    if (!xmlAvailable) return this.getMdDoc();
    const xml = await this.getXml(xmlPath);
    const md = await this.getMdDoc();
    return overlayMdOnXml(xml, md);
  }
}

/**
 * Merge two TimelineDocs for render-only display. The XML doc is the base;
 * any MD event whose id matches replaces the XML version (the MD note is the
 * user's freshest edit), and MD-only events are appended. Category catalog
 * is union-merged by name so newly invented categories show up too.
 */
function overlayMdOnXml(xml: TimelineDoc, md: TimelineDoc): TimelineDoc {
  const byId = new Map<string, TimelineEvent>();
  for (const e of xml.events) byId.set(e.id, e);
  for (const e of md.events) byId.set(e.id, e);
  const catNames = new Set(xml.categories.map((c) => c.name));
  const cats: TimelineCategory[] = xml.categories.slice();
  for (const c of md.categories) {
    if (!catNames.has(c.name)) {
      cats.push(c);
      catNames.add(c.name);
    }
  }
  return {
    ...xml,
    categories: cats,
    events: Array.from(byId.values()),
  };
}

const MD_DOC_TTL_MS = 30_000;
const BATCH = 25;

function yieldToUi(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
