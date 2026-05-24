import YAML from "yaml";
import {
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
  type App,
} from "obsidian";
// YAML only used by parseBlockOptions; render-time YAML reparse for viewport
// has been replaced with metadataCache for performance.
import type { TimelineXmlSyncSettings } from "../settings";
import type { VaultAdapter } from "./vault-adapter";
import type { TimelineCache } from "./cache";
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
  cache: TimelineCache;
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
    // Defer the heavy work until the block scrolls into view. Cheap placeholder
    // first; IntersectionObserver triggers the real render exactly once. Falls
    // back to immediate render if IntersectionObserver isn't available.
    el.createDiv({ cls: "txs-timeline-placeholder", text: "Timeline loading…" });
    const run = () => {
      el.empty();
      void doRender();
    };
    if (typeof IntersectionObserver === "undefined") {
      run();
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            obs.disconnect();
            run();
            return;
          }
        }
      },
      { rootMargin: "200px" }
    );
    obs.observe(el);
    child.register(() => obs.disconnect());

    async function doRender() {
    try {
      const settings = ctx.getSettings();
      const opts = parseBlockOptions(source, settings.renderDefaults);
      const xmlPath = opts.sourceXmlOverride || settings.sourceXmlPath;
      const xmlAvailable = !!xmlPath && ctx.vault.exists(xmlPath);
      let doc;
      const mode = settings.eventSource;
      if (mode === "xml") {
        if (!xmlAvailable) {
          renderError(el, `XML file not found: ${xmlPath ?? "(unset)"}`);
          return;
        }
        doc = await ctx.cache.getXml(xmlPath);
      } else if (mode === "md") {
        doc = await ctx.cache.getMdDoc();
      } else {
        // auto
        doc = xmlAvailable
          ? await ctx.cache.getXml(xmlPath)
          : await ctx.cache.getMdDoc();
      }
      if (!doc.events.length && !xmlAvailable && mode !== "xml") {
        renderError(
          el,
          `No events found. Configure event notes directory or run "Auto-detect event notes" in settings.`
        );
        return;
      }

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
      let viewport = await resolveViewport(ctx, md.sourcePath, doc);
      const padYears = opts.pointPaddingYears ?? settings.pointPaddingYears;
      viewport = expandDegenerateViewport(viewport, padYears);
      if (viewport) {
        events = eventsInViewport(events, viewport);
      }

      const initialHidden = new Set<string>(settings.hiddenCategories);
      if (opts.categoryInclude && opts.categoryInclude.length) {
        // include-mode: hide everything not in the include set
        const inc = new Set(opts.categoryInclude);
        for (const c of doc.categories) if (!inc.has(c.name)) initialHidden.add(c.name);
      }
      if (opts.categoryExclude) {
        for (const c of opts.categoryExclude) initialHidden.add(c);
      }
      renderTimeline({
        container: el,
        events,
        categories: doc.categories,
        viewport: viewport ?? autoViewport(events),
        options: opts,
        onOpenEvent: (id) => {
          const path = ctx.cache.resolvePath(id);
          if (path) ctx.app.workspace.openLinkText(path, "", false);
        },
        categoryColors: settings.categoryColors,
        initialHidden: Array.from(initialHidden),
        filterKey: opts.source || "default",
      });
    } catch (e) {
      renderError(el, (e as Error).message);
    }
    }
  };
}

function renderError(el: HTMLElement, msg: string): void {
  el.empty();
  el.createDiv({ cls: "txs-error", text: `Timeline error: ${msg}` });
}

/** Parse the YAML body of a ```timeline block. */
export function parseBlockOptions(
  source: string,
  base: RenderOptions = DEFAULT_RENDER_OPTIONS
): RenderOptions {
  let parsed: Record<string, unknown> = {};
  try {
    const p = YAML.parse(source);
    if (p && typeof p === "object" && !Array.isArray(p)) {
      parsed = p as Record<string, unknown>;
    }
  } catch {
    // ignore — use defaults
  }
  const opt: RenderOptions = { ...base };
  if (typeof parsed.mode === "string") opt.mode = parsed.mode as RenderOptions["mode"];
  if (typeof parsed.source === "string") opt.source = parsed.source;
  if (typeof parsed.sourceXml === "string") opt.sourceXmlOverride = parsed.sourceXml;
  if (typeof parsed.details === "string") opt.details = parsed.details as RenderOptions["details"];
  if (typeof parsed.sort === "string") opt.sort = parsed.sort as RenderOptions["sort"];
  if (Array.isArray(parsed.show)) {
    opt.show = parsed.show.filter((x): x is string => typeof x === "string") as RenderOptions["show"];
  }
  if (typeof parsed.zoom === "number" && Number.isFinite(parsed.zoom) && parsed.zoom > 0) {
    opt.zoom = parsed.zoom;
  }
  if (parsed.orientation === "vertical" || parsed.orientation === "horizontal") {
    opt.orientation = parsed.orientation;
  }
  if (
    typeof parsed.pointPaddingYears === "number" &&
    Number.isFinite(parsed.pointPaddingYears)
  ) {
    opt.pointPaddingYears = parsed.pointPaddingYears;
  }
  if (typeof parsed.showFilterUI === "boolean") {
    opt.showFilterUI = parsed.showFilterUI;
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
      // Fast path: use metadataCache (no YAML reparse).
      const meta = ctx.app.metadataCache.getFileCache(file);
      const fm = meta?.frontmatter as Record<string, unknown> | undefined;
      if (fm && fm.timeline && typeof fm.timeline === "object") {
        const tl = fm.timeline as Record<string, unknown>;
        const start = asViewportDate(tl.start);
        const end = asViewportDate(tl.end);
        if (start && end) return { start, end };
      }
    }
  }
  if (doc.view?.displayedPeriod) {
    return doc.view.displayedPeriod;
  }
  return null;
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

/**
 * Pad a zero-span (or very narrow) viewport so single-point event notes get
 * usable surrounding context. Returns null when input is null.
 */
function expandDegenerateViewport(
  vp: ViewportRange | null,
  padYears: number
): ViewportRange | null {
  if (!vp) return vp;
  const sameYear = vp.start.year === vp.end.year;
  const sameMonth = (vp.start.month ?? 1) === (vp.end.month ?? 1);
  const sameDay = (vp.start.day ?? 1) === (vp.end.day ?? 1);
  const span = sameYear && sameMonth && sameDay;
  if (!span || padYears <= 0) return vp;
  const pad = Math.max(1, Math.floor(padYears));
  return {
    start: { ...vp.start, year: vp.start.year - pad },
    end: { ...vp.end, year: vp.end.year + pad },
  };
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
