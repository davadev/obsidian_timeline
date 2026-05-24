import { ItemView, Platform, WorkspaceLeaf, type App } from "obsidian";
import type { TimelineXmlSyncSettings } from "../settings";
import type { TimelineCache } from "./cache";
import { renderTimeline } from "../renderer";

export const VIEW_TYPE_TIMELINE = "txs-timeline-view";

export interface TimelineViewArgs {
  app: App;
  cache: TimelineCache;
  getSettings: () => TimelineXmlSyncSettings;
}

/**
 * Workspace-leaf view (like the Graph view) showing the entire timeline.
 * Honors the same eventSource preference as the inline render block, so it
 * works on iOS even when no .timeline XML is present.
 */
export class TimelineView extends ItemView {
  static args: TimelineViewArgs | null = null;

  constructor(leaf: WorkspaceLeaf, private args: TimelineViewArgs) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_TIMELINE;
  }

  getDisplayText(): string {
    return "Timeline";
  }

  getIcon(): string {
    return "calendar-range";
  }

  async onOpen(): Promise<void> {
    await this.render();
    // Refresh on focus so external XML edits show up.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        if (this.app.workspace.getActiveViewOfType(TimelineView) === this) {
          void this.render();
        }
      })
    );
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  private async render(): Promise<void> {
    const { cache, getSettings, app } = this.args;
    const settings = getSettings();
    this.contentEl.empty();
    this.contentEl.addClass("txs-view-root");

    const header = this.contentEl.createDiv({ cls: "txs-view-header" });
    header.createEl("h3", { text: "Timeline" });
    const refreshBtn = header.createEl("button", { text: "Refresh" });
    refreshBtn.addEventListener("click", () => {
      cache.invalidateXml();
      cache.invalidateMdDoc();
      void this.render();
    });

    const container = this.contentEl.createDiv({ cls: "txs-view-body" });

    try {
      const xmlPath = settings.sourceXmlPath;
      const xmlAvailable =
        !!xmlPath && app.vault.getAbstractFileByPath(xmlPath) !== null;
      let doc;
      if (settings.eventSource === "xml") {
        if (!xmlAvailable) {
          container.createDiv({
            cls: "txs-error",
            text: `XML not found: ${xmlPath}`,
          });
          return;
        }
        doc = await cache.getXml(xmlPath);
      } else if (settings.eventSource === "md") {
        doc = await cache.getMdDoc();
      } else {
        doc = xmlAvailable ? await cache.getXml(xmlPath) : await cache.getMdDoc();
      }

      if (!doc.events.length) {
        container.createDiv({
          text: "No events found. Run 'Auto-detect event notes' or import the XML.",
        });
        return;
      }

      // Always span the full event set in the global view (ignore the XML's
      // narrow displayed_period). Auto-pick zoom so dense timelines get a wide
      // scrollable canvas while sparse ones stay readable.
      const fullViewport = autoViewport(doc.events);
      const autoZoom = pickAutoZoom(doc.events.length, fullViewport, container);
      renderTimeline({
        container,
        events: doc.events,
        categories: doc.categories,
        viewport: fullViewport,
        options: {
          ...settings.renderDefaults,
          mode: settings.renderDefaults.mode,
          zoom: autoZoom,
          showFilterUI: true,
        },
        onOpenEvent: (id) => {
          const path = cache.resolvePath(id);
          if (path) app.workspace.openLinkText(path, "", false);
        },
        categoryColors: settings.categoryColors,
        initialHidden: settings.hiddenCategories,
        filterKey: `view:${settings.timelineId}`,
        isMobile: Platform.isMobile,
      });
    } catch (e) {
      container.createDiv({
        cls: "txs-error",
        text: `Timeline view error: ${(e as Error).message}`,
      });
    }
  }
}

function autoViewport(events: { start: { year: number }; end: { year: number } }[]) {
  if (!events.length) return undefined;
  let minY = events[0].start.year;
  let maxY = events[0].end.year;
  for (const e of events) {
    if (e.start.year < minY) minY = e.start.year;
    if (e.end.year > maxY) maxY = e.end.year;
  }
  // Small padding so events at the very edge aren't visually clipped.
  const span = Math.max(1, maxY - minY);
  const pad = Math.max(1, Math.floor(span * 0.02));
  return { start: { year: minY - pad }, end: { year: maxY + pad } };
}

/**
 * Choose a zoom multiplier so the full timeline becomes horizontally
 * scrollable without crowding. Tries to give every event ~60 px of room and
 * every year ~3 px, whichever ends up wider. Clamped to [1, 50].
 */
function pickAutoZoom(
  eventCount: number,
  vp: { start: { year: number }; end: { year: number } } | undefined,
  container: HTMLElement
): number {
  if (!vp) return 1;
  const width = Math.max(320, container.clientWidth || 800);
  const span = Math.max(1, vp.end.year - vp.start.year);
  const desiredByEvents = Math.ceil((eventCount * 60) / width);
  const desiredByYears = Math.ceil((span * 3) / width);
  const z = Math.max(1, desiredByEvents, desiredByYears);
  return Math.min(50, z);
}
