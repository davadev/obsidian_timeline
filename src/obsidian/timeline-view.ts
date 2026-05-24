import { ItemView, WorkspaceLeaf, type App } from "obsidian";
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

      renderTimeline({
        container,
        events: doc.events,
        categories: doc.categories,
        viewport: doc.view?.displayedPeriod ?? autoViewport(doc.events),
        options: {
          ...settings.renderDefaults,
          // Full-view defaults: list+bar combined, generous zoom.
          mode: settings.renderDefaults.mode,
          zoom: Math.max(settings.renderDefaults.zoom, 2),
          showFilterUI: true,
        },
        onOpenEvent: (id) => {
          const path = cache.resolvePath(id);
          if (path) app.workspace.openLinkText(path, "", false);
        },
        categoryColors: settings.categoryColors,
        initialHidden: settings.hiddenCategories,
        filterKey: `view:${settings.timelineId}`,
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
  return { start: { year: minY }, end: { year: maxY } };
}
