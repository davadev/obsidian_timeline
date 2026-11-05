// @vitest-environment jsdom
import "../testUtils/setup-obsidian-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Notice } from "../testUtils/obsidian";
import { exportActiveNoteWithRenderedTimeline, type ExportContext } from "../src/obsidian/export";
import { VaultAdapter } from "../src/obsidian/vault-adapter";
import { DEFAULT_SETTINGS, type TimelineXmlSyncSettings } from "../src/settings";
import type { TimelineDoc, TimelineEvent } from "../src/timeline/model";
import { FakeApp } from "../testUtils/fake-app";

const d = (year: number) => ({ year });
const ev = (id: string, a: number, b: number, over: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id, text: `Event ${id}`, start: d(a), end: d(b), isPoint: a === b, ...over,
});

let app: FakeApp;
let settings: TimelineXmlSyncSettings;
let doc: TimelineDoc | Error;
let ctx: ExportContext;
let canvas: { width: number; height: number; getContext: () => unknown; toBlob: (cb: (b: unknown) => void) => void };
let imageFails: boolean;

const NOTE = "Intro\n```timeline\nmode: bar\n```\nMiddle\n```timeline\nmode: bar\ncategories:\n  include: [War]\n```\nEnd";

beforeEach(() => {
  Notice.reset();
  app = new FakeApp();
  settings = { ...DEFAULT_SETTINGS, eventNotesDir: "Events", hiddenCategories: [] };
  doc = { categories: [], eras: [{ id: "e", name: "Era", start: d(0), end: d(1000) }], events: [ev("a", 100, 200, { category: "War" }), ev("b", 300, 300, { category: "Peace" })] };
  const withSelfWrite = vi.fn((fn: () => Promise<unknown>) => fn()) as unknown as ExportContext["withSelfWrite"];
  ctx = {
    app: app as never,
    vault: new VaultAdapter(app as never),
    cache: { getRenderDoc: async () => { if (doc instanceof Error) throw doc; return doc; } } as never,
    getSettings: () => settings,
    withSelfWrite,
  };
  app.vault.seed("Notes/Trip.md", NOTE);
  app.activeFile = app.vault.getFiles()[0];

  imageFails = false;
  canvas = {
    width: 0, height: 0,
    getContext: () => ({ fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() }),
    toBlob: (cb) => cb({ arrayBuffer: async () => new ArrayBuffer(8) }),
  };
  vi.stubGlobal("createEl", (tag: string) => (tag === "canvas" ? canvas : document.createElement(tag)));
  vi.stubGlobal("Image", class {
    onload: () => void = () => {};
    onerror: () => void = () => {};
    set src(_v: string) {
      queueMicrotask(() => (imageFails ? this.onerror() : this.onload()));
    }
  });
  URL.createObjectURL = vi.fn(() => "blob:fake");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("exportActiveNoteWithRenderedTimeline", () => {
  it("needs an active note with a timeline block", async () => {
    app.activeFile = null;
    await exportActiveNoteWithRenderedTimeline(ctx);
    expect(Notice.messages()).toEqual(["No active note."]);
    app.activeFile = app.vault.seed("Plain.md", "nothing here");
    await exportActiveNoteWithRenderedTimeline(ctx);
    expect(Notice.messages()[1]).toBe("Active note has no ```timeline blocks.");
  });

  it("replaces each block with an image and a static list, in a sibling file, leaving the original alone", async () => {
    await exportActiveNoteWithRenderedTimeline(ctx);
    const out = app.vault.text("Notes/Trip-exported.md");
    expect(out).toContain("![[Events/_attachments/Trip-timeline-1.png]]");
    expect(out).toContain("![[Events/_attachments/Trip-timeline-2.png]]");
    expect(out).toContain("- **Event a** — `0100-01-01 → 0200-01-01` _(War)_");
    expect(out).toContain("- **Event b** — `0300-01-01`"); // the first block has no filter
    expect(out.startsWith("Intro\n")).toBe(true);
    expect(out).toContain("\nMiddle\n");
    expect(out.endsWith("End")).toBe(true);
    expect(out).not.toContain("```timeline");
    expect(app.vault.text("Notes/Trip.md")).toBe(NOTE);
    expect(app.vault.files.has("Events/_attachments/Trip-timeline-1.png")).toBe(true);
    expect(Notice.messages()).toEqual(["Exported to Notes/Trip-exported.md (2 block(s) → image + list)."]);
    expect(URL.revokeObjectURL).toHaveBeenCalled();
    expect(ctx.withSelfWrite).toHaveBeenCalledTimes(3);
  });

  it("skips blocks whose filters leave nothing, and says when nothing was exported", async () => {
    settings.hiddenCategories = ["War", "Peace"];
    await exportActiveNoteWithRenderedTimeline(ctx);
    expect(Notice.messages()).toEqual(["Nothing exported."]);
    expect(app.vault.files.has("Notes/Trip-exported.md")).toBe(false);
  });

  it("warns and skips when no timeline data can be loaded", async () => {
    doc = new Error("no data");
    await exportActiveNoteWithRenderedTimeline(ctx);
    expect(Notice.messages()).toEqual(["No timeline data available — skipping block.", "No timeline data available — skipping block.", "Nothing exported."]);
  });

  it("applies the block's own filters: categories, names, range, labels", async () => {
    doc = {
      categories: [],
      events: [
        ev("a", 100, 200, { category: "War", labels: ["x"], text: "Rome falls" }),
        ev("b", 300, 400, { category: "Peace", labels: ["y"], text: "Treaty" }),
        ev("c", 500, 600, { text: "Uncategorised" }),
      ],
    };
    const exported = async (body: string) => {
      app.vault.seed("Notes/Trip.md", `\`\`\`timeline\n${body}\n\`\`\``);
      await exportActiveNoteWithRenderedTimeline(ctx);
      return app.vault.text("Notes/Trip-exported.md");
    };
    expect(await exported("categories:\n  exclude: [War]")).not.toContain("Rome falls");
    expect(await exported("categories:\n  include: [War]")).not.toContain("Treaty");
    expect(await exported("events: [treaty]")).not.toContain("Rome falls");
    expect(await exported("range: [250, 450]")).not.toContain("Uncategorised");
    expect(await exported("labels:\n  include: [y]")).toContain("Treaty");
    expect(await exported("labels:\n  include: [y]")).not.toContain("Rome falls");
  });

  it("sanitises the attachment name", async () => {
    app.activeFile = app.vault.seed("Notes/My trip!.md", "```timeline\nmode: bar\n```");
    await exportActiveNoteWithRenderedTimeline(ctx);
    expect(app.vault.files.has("Events/_attachments/My-trip--timeline-1.png")).toBe(true);
  });

  it("fits the image to the span however the events are ordered", async () => {
    doc = { categories: [], events: [ev("late", 500, 900), ev("early", 100, 200)] };
    app.vault.seed("Notes/Trip.md", "```timeline\nmode: bar\n```");
    await exportActiveNoteWithRenderedTimeline(ctx);
    const out = app.vault.text("Notes/Trip-exported.md");
    expect(out.indexOf("Event early")).toBeLessThan(out.indexOf("Event late")); // list is chronological
  });

  it("propagates drawing failures instead of writing a half-exported note", async () => {
    canvas.getContext = () => null;
    await expect(exportActiveNoteWithRenderedTimeline(ctx)).rejects.toThrow("Canvas 2D not available");
    canvas.getContext = () => ({ fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() });
    canvas.toBlob = (cb) => cb(null);
    await expect(exportActiveNoteWithRenderedTimeline(ctx)).rejects.toThrow("canvas.toBlob returned null");
    canvas.toBlob = (cb) => cb({ arrayBuffer: async () => { throw new Error("blob read"); } });
    await expect(exportActiveNoteWithRenderedTimeline(ctx)).rejects.toThrow("blob read");
    imageFails = true;
    await expect(exportActiveNoteWithRenderedTimeline(ctx)).rejects.toThrow("Image load failed: blob:fake");
    expect(app.vault.files.has("Notes/Trip-exported.md")).toBe(false);
  });

  it("falls back to default image dimensions when the SVG declares none", async () => {
    const orig = SVGSVGElement.prototype.getAttribute;
    vi.spyOn(SVGSVGElement.prototype, "getAttribute").mockImplementation(function (this: SVGSVGElement, name: string) {
      return name === "width" || name === "height" ? null : orig.call(this, name);
    });
    await exportActiveNoteWithRenderedTimeline(ctx);
    expect(canvas.width).toBe(1200);
    expect(canvas.height).toBe(400);
  });
});
