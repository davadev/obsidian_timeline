import { Notice, TFile, type App } from "obsidian";
import type { TimelineXmlSyncSettings } from "../settings";
import type { TimelineCache } from "./cache";
import type { VaultAdapter } from "./vault-adapter";
import { parseBlockOptions } from "./markdown-postprocessor";
import { renderTimeline } from "../renderer";
import { compare, toFrontmatterString } from "../timeline/date";
import { eventsInViewport } from "../timeline/overlap";
import type { TimelineEvent } from "../timeline/model";

export interface ExportContext {
  app: App;
  vault: VaultAdapter;
  cache: TimelineCache;
  getSettings: () => TimelineXmlSyncSettings;
  withSelfWrite: <T>(fn: () => Promise<T>) => Promise<T>;
}

/**
 * Walks the active note for ```timeline blocks, renders each to an SVG,
 * converts to PNG via a browser canvas, writes the PNG into the vault, and
 * replaces the fenced block in the output file with the image plus a static
 * Markdown list of the rendered events. Keeps the original note unchanged
 * — writes a sibling `<name>-exported.md` so the user can diff or share.
 */
export async function exportActiveNoteWithRenderedTimeline(
  ctx: ExportContext
): Promise<void> {
  const active = ctx.app.workspace.getActiveFile();
  if (!active) {
    new Notice("No active note.");
    return;
  }
  const raw = await ctx.vault.readText(active.path);
  const blocks = extractTimelineBlocks(raw);
  if (!blocks.length) {
    new Notice("Active note has no ```timeline blocks.");
    return;
  }

  const settings = ctx.getSettings();
  const out = raw.split("");
  let written = 0;
  // Process blocks back-to-front so earlier indices remain valid.
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    const opts = parseBlockOptions(block.body, settings.renderDefaults);
    const doc = await loadDoc(ctx);
    if (!doc) {
      new Notice("No timeline data available — skipping block.");
      continue;
    }

    const events = filterEvents(doc.events, opts, settings.hiddenCategories);
    if (!events.length) continue;
    const vp = autoViewport(events);

    // Render off-screen
    const stage = document.body.createDiv({ cls: "txs-export-stage" });
    try {
      renderTimeline({
        container: stage,
        events,
        categories: doc.categories,
        viewport: vp,
        options: { ...opts, mode: "bar", showFilterUI: false },
        onOpenEvent: () => {},
        categoryColors: settings.categoryColors,
        initialHidden: [],
        filterKey: `export:${active.path}:${i}`,
        isMobile: false,
        fuzzyGradientPercent: settings.fuzzyGradientPercent,
        eventLabelColor: settings.eventLabelColor,
      });
      const svg = stage.querySelector("svg");
      if (!svg) continue;
      const png = await svgToPng(svg);
      const attDir = `${settings.eventNotesDir}/_attachments`;
      await ctx.vault.ensureFolder(attDir);
      const safe = active.basename.replace(/[^A-Za-z0-9-_]+/g, "-");
      const attPath = `${attDir}/${safe}-timeline-${i + 1}.png`;
      await ctx.withSelfWrite(async () => {
        await ctx.vault.writeBinary(attPath, png);
      });
      const listMd = renderStaticList(events);
      const replacement = `![[${attPath}]]\n\n${listMd}\n`;
      out.splice(
        block.startCharIndex,
        block.endCharIndex - block.startCharIndex,
        replacement
      );
      written++;
    } finally {
      stage.remove();
    }
  }

  if (!written) {
    new Notice("Nothing exported.");
    return;
  }
  const outPath = active.path.replace(/\.md$/i, "") + "-exported.md";
  await ctx.withSelfWrite(async () => {
    await ctx.vault.writeText(outPath, out.join(""));
  });
  new Notice(`Exported to ${outPath} (${written} block(s) → image + list).`);
}

async function loadDoc(ctx: ExportContext) {
  try {
    return await ctx.cache.getRenderDoc();
  } catch {
    return null;
  }
}

function filterEvents(
  events: TimelineEvent[],
  opts: ReturnType<typeof parseBlockOptions>,
  globalHidden: string[]
): TimelineEvent[] {
  let filtered = events;
  if (opts.categoryInclude && opts.categoryInclude.length) {
    const inc = new Set(opts.categoryInclude);
    filtered = filtered.filter((e) => e.category && inc.has(e.category));
  }
  if (opts.categoryExclude && opts.categoryExclude.length) {
    const exc = new Set(opts.categoryExclude);
    filtered = filtered.filter((e) => !e.category || !exc.has(e.category));
  }
  const hidden = new Set(globalHidden);
  filtered = filtered.filter((e) => !e.category || !hidden.has(e.category));
  if (opts.rangeYears) {
    const [a, b] = opts.rangeYears;
    filtered = filtered.filter((e) => e.start.year <= b && e.end.year >= a);
  }
  if (opts.eventNames && opts.eventNames.length) {
    const needles = opts.eventNames.map((s) => s.toLowerCase());
    filtered = filtered.filter((e) =>
      needles.some((n) => e.text.toLowerCase().includes(n))
    );
  }
  if (opts.labelsInclude && opts.labelsInclude.length) {
    const inc = new Set(opts.labelsInclude);
    filtered = filtered.filter((e) =>
      (e.labels ?? []).some((l) => inc.has(l))
    );
  }
  return filtered;
}

function autoViewport(events: TimelineEvent[]) {
  let minY = events[0].start.year;
  let maxY = events[0].end.year;
  for (const e of events) {
    if (e.start.year < minY) minY = e.start.year;
    if (e.end.year > maxY) maxY = e.end.year;
  }
  return { start: { year: minY }, end: { year: maxY } };
}

function renderStaticList(events: TimelineEvent[]): string {
  const sorted = events.slice().sort((a, b) => compare(a.start, b.start));
  return sorted
    .map((e) => {
      const date = e.isPoint
        ? toFrontmatterString(e.start)
        : `${toFrontmatterString(e.start)} → ${toFrontmatterString(e.end)}`;
      const cat = e.category ? ` _(${e.category})_` : "";
      return `- **${e.text}** — \`${date}\`${cat}`;
    })
    .join("\n");
}

interface BlockLocation {
  startCharIndex: number;
  endCharIndex: number;
  body: string;
}

/**
 * Walks the raw markdown for ```timeline … ``` fences. Returns absolute
 * character indices so we can splice the file content in-place without
 * re-flowing the surrounding text.
 */
function extractTimelineBlocks(md: string): BlockLocation[] {
  const out: BlockLocation[] = [];
  const re = /^```timeline\s*\n([\s\S]*?)\n```\s*$/gm;
  let m;
  while ((m = re.exec(md)) !== null) {
    out.push({
      startCharIndex: m.index,
      endCharIndex: m.index + m[0].length,
      body: m[1],
    });
  }
  return out;
}

async function svgToPng(svg: SVGSVGElement): Promise<ArrayBuffer> {
  // Inline computed styles so the off-document SVG renders correctly.
  const cloned = svg.cloneNode(true) as SVGSVGElement;
  const w = Number(svg.getAttribute("width")) || svg.clientWidth || 1200;
  const h = Number(svg.getAttribute("height")) || svg.clientHeight || 400;
  cloned.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  cloned.setAttribute("width", String(w));
  cloned.setAttribute("height", String(h));
  const serialized = new XMLSerializer().serializeToString(cloned);
  const blob = new Blob([serialized], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const canvas = createEl("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) throw new Error("Canvas 2D not available");
    ctx2d.fillStyle = "white";
    ctx2d.fillRect(0, 0, w, h);
    ctx2d.drawImage(img, 0, 0, w, h);
    return await new Promise<ArrayBuffer>((resolve, reject) => {
      canvas.toBlob((b) => {
        if (!b) return reject(new Error("canvas.toBlob returned null"));
        b.arrayBuffer().then(resolve, reject);
      }, "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Image load failed: ${url}`));
    img.src = url;
  });
}

// Silence unused-import warnings if these get pruned later.
void eventsInViewport;
void TFile;
