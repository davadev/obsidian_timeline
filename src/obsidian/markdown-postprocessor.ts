import YAML from "yaml";
import {
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
  Platform,
  TFile,
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
import { autoViewportFromEvents } from "../timeline/era-utils";
import { renderTimeline } from "../renderer";
import { DEFAULT_RENDER_OPTIONS, type RenderOptions } from "../renderer/render-options";
import { parseFrontmatterDate, type TimelineDate } from "../timeline/date";

export interface PostProcessorContext {
  app: App;
  vault: VaultAdapter;
  cache: TimelineCache;
  getSettings: () => TimelineXmlSyncSettings;
  /** Single click router — plugin decides whether to open the note or inspector. */
  onEventClick: (id: string) => void;
  onEraClick: (id: string) => void;
  /** Optional sync log appender for diagnostic events (e.g. filter persist miss). */
  appendSyncLog?: (event: string, path: string, detail: string) => Promise<void>;
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
      try {
        // sourceXml block override still routes through the cache directly;
        // the global merging only applies to the configured XML.
        if (opts.sourceXmlOverride && xmlAvailable) {
          doc = await ctx.cache.getXml(xmlPath);
        } else {
          doc = await ctx.cache.getRenderDoc();
        }
      } catch (e) {
        renderError(el, (e as Error).message);
        return;
      }
      if (!doc.events.length) {
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

      // Search filter (case-insensitive over title/description/category).
      if (opts.search && opts.search.trim()) {
        const q = opts.search.trim().toLowerCase();
        events = events.filter((e) =>
          (`${e.text}\n${e.description ?? ""}\n${e.category ?? ""}`).toLowerCase().includes(q)
        );
      }

      // Event-name filter (case-insensitive substring against title).
      if (opts.eventNames && opts.eventNames.length) {
        const needles = opts.eventNames.map((s) => s.toLowerCase());
        events = events.filter((e) =>
          needles.some((n) => e.text.toLowerCase().includes(n))
        );
      }

      // Year-range filter — keep events overlapping [from, to].
      if (opts.rangeYears) {
        const [from, to] = opts.rangeYears;
        events = events.filter(
          (e) => e.start.year <= to && e.end.year >= from
        );
      }

      // Label include/exclude.
      if (opts.labelsInclude && opts.labelsInclude.length) {
        const inc = new Set(opts.labelsInclude);
        events = events.filter((e) =>
          (e.labels ?? []).some((l) => inc.has(l))
        );
      }
      if (opts.labelsExclude && opts.labelsExclude.length) {
        const exc = new Set(opts.labelsExclude);
        events = events.filter((e) =>
          !(e.labels ?? []).some((l) => exc.has(l))
        );
      }

      // Viewport policy:
      //   - block YAML `viewport: true`  → always use host frontmatter / XML period
      //   - block YAML `viewport: false` → never use it (insert-block default)
      //   - omitted                      → use ONLY when host note's
      //                                    `timeline.role` is "viewport".
      //
      // Reason for the new default: blocks dropped into an event note used to
      // silently inherit that event's start/end as a hard filter, so the same
      // filter values yielded fewer events in the inserted block than in the
      // global view. Now event notes don't auto-restrict; viewport-role notes
      // do (which is what they're for), and any block can override either way.
      let viewport: ViewportRange | null = null;
      const useViewport =
        opts.useViewport === true
          ? true
          : opts.useViewport === false
            ? false
            : await hostIsViewportNote(ctx, md.sourcePath);
      if (useViewport) {
        viewport = await resolveViewport(ctx, md.sourcePath, doc);
        const padYears = opts.pointPaddingYears ?? settings.pointPaddingYears;
        viewport = expandDegenerateViewport(viewport, padYears);
        if (viewport) {
          events = eventsInViewport(events, viewport);
        }
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
      const resolvedViewport = viewport ?? autoViewport(events) ?? null;
      renderTimeline({
        container: el,
        events,
        categories: doc.categories,
        // Pass eras unfiltered — the renderer re-filters them against the
        // active viewport on every filter tick, so pre-filtering here would
        // make eras impossible to re-introduce after the user widens a range
        // filter.
        eras: doc.eras,
        viewport: resolvedViewport ?? undefined,
        options: opts,
        onOpenEvent: (id) => ctx.onEventClick(id),
        onOpenEra: (id) => ctx.onEraClick(id),
        categoryColors: settings.categoryColors,
        initialHidden: Array.from(initialHidden),
        filterKey: opts.source || "default",
        isMobile: Platform.isMobile,
        filterPrecision: settings.globalFilterPrecision,
        fuzzyGradientPercent: settings.fuzzyGradientPercent,
        eventLabelColor: settings.eventLabelColor,
        // Persist filter state directly into the block YAML so it survives a
        // note reload and travels with the note across devices. Falls back to
        // the device-local state if the file write fails (e.g. the block
        // lives in an embedded note we can't locate).
        onFilterChange: makeBlockPersister(ctx, md.sourcePath, source),
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
    const p: unknown = YAML.parse(source);
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
  if (typeof parsed.stickyLabels === "boolean") {
    opt.stickyLabels = parsed.stickyLabels;
  }
  if (typeof parsed.showFilterUI === "boolean") {
    opt.showFilterUI = parsed.showFilterUI;
  }
  if (Array.isArray(parsed.events)) {
    opt.eventNames = parsed.events.filter((x): x is string => typeof x === "string");
  } else if (typeof parsed.event === "string") {
    opt.eventNames = [parsed.event];
  }
  if (Array.isArray(parsed.range) && parsed.range.length === 2) {
    const [a, b] = parsed.range as [unknown, unknown];
    if (typeof a === "number" && typeof b === "number") {
      opt.rangeYears = [Math.min(a, b), Math.max(a, b)];
    }
  }
  const labels = parsed.labels as Record<string, unknown> | undefined;
  if (labels && typeof labels === "object") {
    if (Array.isArray(labels.include))
      opt.labelsInclude = labels.include.filter((x): x is string => typeof x === "string");
    if (Array.isArray(labels.exclude))
      opt.labelsExclude = labels.exclude.filter((x): x is string => typeof x === "string");
  }
  if (typeof parsed.search === "string") opt.search = parsed.search;
  if (typeof parsed.viewport === "boolean") opt.useViewport = parsed.viewport;
  // Alternative spelling for clarity.
  if (typeof parsed.useViewport === "boolean") opt.useViewport = parsed.useViewport;
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
      const fm = meta?.frontmatter;
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
  return parseFrontmatterDate(v);
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

/**
 * Returns a debounced callback that, on each rich-filter-state change, writes
 * the equivalent YAML back into the block's source in the file. The matched
 * block is identified by its current body — we keep a mutable ref to the
 * last-written body so subsequent edits chain correctly.
 */
function makeBlockPersister(
  ctx: PostProcessorContext,
  sourcePath: string,
  originalSource: string
): (state: import("../renderer/filter-bar").RichFilterState) => void {
  let currentBody = originalSource;
  let timer: number | null = null;
  let pendingState: import("../renderer/filter-bar").RichFilterState | null = null;

  /** Run vault.process; return true if the old fence was found and replaced. */
  const tryReplace = async (
    file: TFile,
    oldFence: string,
    newFence: string
  ): Promise<boolean> => {
    let replaced = false;
    try {
      await ctx.app.vault.process(file, (raw) => {
        if (!raw.includes(oldFence)) return raw;
        replaced = true;
        return raw.replace(oldFence, newFence);
      });
    } catch {
      return false;
    }
    return replaced;
  };

  const flush = async () => {
    timer = null;
    const state = pendingState;
    pendingState = null;
    if (!state) return;
    if (!sourcePath) return;
    const file = ctx.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) return;
    const nextBody = serializeBlockBody(currentBody, state);
    if (nextBody === currentBody) return;
    const oldFence = "```timeline\n" + currentBody + "\n```";
    const newFence = "```timeline\n" + nextBody + "\n```";
    if (await tryReplace(file, oldFence, newFence)) {
      currentBody = nextBody;
      return;
    }
    // Old fence missing — another device (or the user) likely rewrote the
    // block. Re-read the file, pick the first ```timeline``` block, and retry
    // once with its current body as the new baseline.
    try {
      const raw = await ctx.app.vault.read(file);
      const match = /```timeline\n([\s\S]*?)\n```/.exec(raw);
      if (match) {
        const freshBody = match[1];
        const freshNext = serializeBlockBody(freshBody, state);
        if (freshNext !== freshBody) {
          const oldF2 = "```timeline\n" + freshBody + "\n```";
          const newF2 = "```timeline\n" + freshNext + "\n```";
          if (await tryReplace(file, oldF2, newF2)) {
            currentBody = freshNext;
            return;
          }
        } else {
          currentBody = freshBody; // converged on someone else's write
          return;
        }
      }
    } catch {
      // fall through to log
    }
    void ctx.appendSyncLog?.(
      "filter-persist-failed",
      sourcePath,
      "could not locate timeline block to update"
    );
    // State remains in device-local storage — UI stays consistent.
  };

  return (state) => {
    pendingState = state;
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => void flush(), 600);
  };
}

/**
 * Build the new block YAML by parsing the existing body, overlaying the
 * filter state, and re-serialising. Preserves any other options the user
 * may have typed (mode, zoom, orientation, source, etc).
 */
function serializeBlockBody(
  body: string,
  state: import("../renderer/filter-bar").RichFilterState
): string {
  let doc: Record<string, unknown> = {};
  try {
    const p: unknown = YAML.parse(body);
    if (p && typeof p === "object" && !Array.isArray(p)) doc = p as Record<string, unknown>;
  } catch {
    // ignore — start clean
  }

  // search
  if (state.search && state.search.trim()) doc.search = state.search.trim();
  else delete doc.search;

  // labels.include
  const labelsExisting =
    (doc.labels && typeof doc.labels === "object" && !Array.isArray(doc.labels)
      ? (doc.labels as Record<string, unknown>)
      : {});
  if (state.labels.length) labelsExisting.include = state.labels;
  else delete labelsExisting.include;
  if (Object.keys(labelsExisting).length === 0) delete doc.labels;
  else doc.labels = labelsExisting;

  // categories.exclude
  const catsExisting =
    (doc.categories && typeof doc.categories === "object" && !Array.isArray(doc.categories)
      ? (doc.categories as Record<string, unknown>)
      : {});
  const hidden = Array.from(state.hiddenCategories);
  if (hidden.length) catsExisting.exclude = hidden;
  else delete catsExisting.exclude;
  if (Object.keys(catsExisting).length === 0) delete doc.categories;
  else doc.categories = catsExisting;

  // range
  if (state.start && state.end) doc.range = [state.start.year, state.end.year];
  else delete doc.range;

  // zoom override
  if (state.zoom != null) doc.zoom = state.zoom;
  // (do not delete zoom if it was originally set without an override — only
  // when the user explicitly clears the filter's zoom field we drop it.)
  else if (Object.prototype.hasOwnProperty.call(doc, "zoom")) delete doc.zoom;

  return YAML.stringify(doc, { lineWidth: 0 }).trimEnd();
}

/**
 * Returns true when the host note's frontmatter declares
 * `timeline.role: viewport`. Used to decide whether an inline ```timeline
 * block should inherit the host's start/end as a viewport when the block
 * itself didn't specify a `viewport` opt.
 */
async function hostIsViewportNote(
  ctx: PostProcessorContext,
  sourcePath: string
): Promise<boolean> {
  if (!sourcePath) return false;
  const file = ctx.vault.getFile(sourcePath);
  if (!file) return false;
  const meta = ctx.app.metadataCache.getFileCache(file);
  const fm = meta?.frontmatter;
  if (!fm) return false;
  const tl = fm.timeline as Record<string, unknown> | undefined;
  if (!tl || typeof tl !== "object" || Array.isArray(tl)) return false;
  return tl.role === "viewport";
}

// filterErasToViewport + autoViewport moved to ../timeline/era-utils so the
// renderer can re-filter eras dynamically on every filter tick. This shim
// keeps the existing single call site here happy.
function autoViewport(events: TimelineEvent[]): ViewportRange | undefined {
  return autoViewportFromEvents(events);
}
