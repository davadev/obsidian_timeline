import YAML from "yaml";
import {
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
  type App,
} from "obsidian";
import type { TimelineXmlSyncSettings } from "../settings";
import type { VaultAdapter } from "./vault-adapter";
import { parseTimelineXml } from "../timeline/xml-parser";
import { parseEventNote } from "../timeline/markdown-parser";
import {
  eventsInViewport,
  type ViewportRange,
} from "../timeline/overlap";
import type { TimelineEvent } from "../timeline/model";
import { renderTimeline } from "../renderer";
import { DEFAULT_RENDER_OPTIONS, type RenderOptions } from "../renderer/render-options";
import { parseFrontmatterDate, type TimelineDate } from "../timeline/date";

export interface PostProcessorContext {
  app: App;
  vault: VaultAdapter;
  getSettings: () => TimelineXmlSyncSettings;
}

/**
 * Registers the ```timeline fenced-block post-processor.
 *
 * Reads source XML + viewport hints from the current note's frontmatter (or
 * embedded note when rendered via ![[note]]). All work is async because we
 * may need to read the XML file via the vault.
 */
export function makeTimelineProcessor(ctx: PostProcessorContext) {
  return async function processTimelineBlock(
    source: string,
    el: HTMLElement,
    md: MarkdownPostProcessorContext
  ) {
    const child = new MarkdownRenderChild(el);
    md.addChild(child);
    try {
      const opts = parseBlockOptions(source);
      const settings = ctx.getSettings();
      const xmlPath = opts.sourceXmlOverride || settings.sourceXmlPath;
      if (!xmlPath) {
        renderError(el, "No source XML configured. Set it in plugin settings.");
        return;
      }
      if (!ctx.vault.exists(xmlPath)) {
        renderError(el, `XML file not found: ${xmlPath}`);
        return;
      }
      const xml = await ctx.vault.readText(xmlPath);
      const doc = parseTimelineXml(xml);

      // Filter by category include/exclude
      let events: TimelineEvent[] = doc.events;
      if (opts.categoryInclude && opts.categoryInclude.length) {
        const inc = new Set(opts.categoryInclude);
        events = events.filter((e) => e.category && inc.has(e.category));
      }
      if (opts.categoryExclude && opts.categoryExclude.length) {
        const exc = new Set(opts.categoryExclude);
        events = events.filter((e) => !e.category || !exc.has(e.category));
      }

      // Viewport: from current note frontmatter, or from XML displayed_period
      const viewport = await resolveViewport(ctx, md.sourcePath, doc);
      if (viewport) {
        events = eventsInViewport(events, viewport);
      }

      // Build a path map for click-through navigation: event_id -> note path
      const idToPath = await indexEventNotes(ctx, settings.eventNotesDir);

      renderTimeline({
        container: el,
        events,
        categories: doc.categories,
        viewport: viewport ?? autoViewport(events),
        options: opts,
        onOpenEvent: (id) => {
          const path = idToPath.get(id);
          if (path) ctx.app.workspace.openLinkText(path, "", false);
        },
        categoryColors: settings.categoryColors,
      });
    } catch (e) {
      renderError(el, (e as Error).message);
    }
  };
}

function renderError(el: HTMLElement, msg: string): void {
  el.empty();
  el.createDiv({ cls: "txs-error", text: `Timeline error: ${msg}` });
}

/** Parse the YAML body of a ```timeline block. */
export function parseBlockOptions(source: string): RenderOptions {
  let parsed: Record<string, unknown> = {};
  try {
    const p = YAML.parse(source);
    if (p && typeof p === "object" && !Array.isArray(p)) {
      parsed = p as Record<string, unknown>;
    }
  } catch {
    // ignore — use defaults
  }
  const opt: RenderOptions = { ...DEFAULT_RENDER_OPTIONS };
  if (typeof parsed.mode === "string") opt.mode = parsed.mode as RenderOptions["mode"];
  if (typeof parsed.source === "string") opt.source = parsed.source;
  if (typeof parsed.sourceXml === "string") opt.sourceXmlOverride = parsed.sourceXml;
  if (typeof parsed.details === "string") opt.details = parsed.details as RenderOptions["details"];
  if (typeof parsed.sort === "string") opt.sort = parsed.sort as RenderOptions["sort"];
  if (Array.isArray(parsed.show)) {
    opt.show = parsed.show.filter((x): x is string => typeof x === "string") as RenderOptions["show"];
  }
  const cats = parsed.categories as Record<string, unknown> | undefined;
  if (cats && typeof cats === "object") {
    if (Array.isArray(cats.include))
      opt.categoryInclude = cats.include.filter((x): x is string => typeof x === "string");
    if (Array.isArray(cats.exclude))
      opt.categoryExclude = cats.exclude.filter((x): x is string => typeof x === "string");
  }
  return opt;
}

async function resolveViewport(
  ctx: PostProcessorContext,
  sourcePath: string,
  doc: { view?: { displayedPeriod?: ViewportRange } }
): Promise<ViewportRange | null> {
  if (sourcePath) {
    const file = ctx.vault.getFile(sourcePath);
    if (file) {
      const raw = await ctx.vault.readText(file.path);
      const parsed = parseEventNote(raw, { path: file.path });
      // Extract viewport from frontmatter even if it's a non-event "viewport" note
      const fm = extractFrontmatter(raw);
      if (fm && fm.timeline && typeof fm.timeline === "object") {
        const tl = fm.timeline as Record<string, unknown>;
        const start = asViewportDate(tl.start);
        const end = asViewportDate(tl.end);
        if (start && end) return { start, end };
      }
      if (parsed.note) {
        return {
          start: parsed.note.event.start,
          end: parsed.note.event.end,
        };
      }
    }
  }
  if (doc.view?.displayedPeriod) {
    return doc.view.displayedPeriod;
  }
  return null;
}

function extractFrontmatter(raw: string): Record<string, unknown> | null {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return null;
  try {
    const p = YAML.parse(m[1]);
    return p && typeof p === "object" ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asViewportDate(v: unknown): TimelineDate | null {
  if (v == null) return null;
  if (typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (typeof o.year === "number") {
      return {
        year: o.year,
        month: typeof o.month === "number" ? o.month : undefined,
        day: typeof o.day === "number" ? o.day : undefined,
        hour: typeof o.hour === "number" ? o.hour : undefined,
        minute: typeof o.minute === "number" ? o.minute : undefined,
        second: typeof o.second === "number" ? o.second : undefined,
      };
    }
    return null;
  }
  return parseFrontmatterDate(v as string | number);
}

async function indexEventNotes(
  ctx: PostProcessorContext,
  dir: string
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!dir) return map;
  const files = ctx.vault.listMarkdownFiles(dir);
  for (const f of files) {
    try {
      const raw = await ctx.vault.readText(f.path);
      const p = parseEventNote(raw, { path: f.path });
      if (p.note) map.set(p.note.event.id, f.path);
    } catch {
      // ignore unreadable
    }
  }
  return map;
}

function autoViewport(events: TimelineEvent[]): ViewportRange | undefined {
  if (events.length === 0) return undefined;
  let start = events[0].start;
  let end = events[0].end;
  for (const e of events) {
    if (compareViewport(e.start, start) < 0) start = e.start;
    if (compareViewport(e.end, end) > 0) end = e.end;
  }
  return { start, end };
}

function compareViewport(
  a: { year: number; month?: number; day?: number },
  b: { year: number; month?: number; day?: number }
): number {
  if (a.year !== b.year) return a.year - b.year;
  if ((a.month ?? 1) !== (b.month ?? 1)) return (a.month ?? 1) - (b.month ?? 1);
  return (a.day ?? 1) - (b.day ?? 1);
}
