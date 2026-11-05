// @vitest-environment jsdom
import "../testUtils/setup-obsidian-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimelineCache } from "../src/obsidian/cache";
import { DEFAULT_SETTINGS, type TimelineXmlSyncSettings } from "../src/settings";
import { FakeApp } from "../testUtils/fake-app";

const XML = `<?xml version="1.0" encoding="utf-8"?><timeline><version>2.11.0</version>
<categories><category><name>War</name><color>1,2,3</color></category></categories>
<events><event id="x1"><start>0100-01-01 00:00:00</start><end>0200-01-01 00:00:00</end><text>From XML</text><category>War</category></event>
<event id="shared"><start>0300-01-01 00:00:00</start><end>0400-01-01 00:00:00</end><text>XML version</text></event></events>
<eras><era><name>XML era</name><start>0001-01-01 00:00:00</start><end>0500-01-01 00:00:00</end></era></eras></timeline>`;

const note = (id: string, title: string, category = "Peace") =>
  `---\ntitle: ${title}\ntimeline:\n  enabled: true\n  event_id: ${id}\n  category: ${category}\n  start: {year: 600}\n  end: {year: 700}\n---\n# ${title}\n`;
const eraNote = (id: string) =>
  `---\ntitle: MD era\ntimeline:\n  enabled: true\n  role: era\n  era_id: ${id}\n  start: {year: 10}\n  end: {year: 20}\n---\n`;

let app: FakeApp;
let settings: TimelineXmlSyncSettings;
let cache: TimelineCache;
beforeEach(() => {
  app = new FakeApp();
  settings = { ...DEFAULT_SETTINGS, eventNotesDir: "Events", sourceXmlPath: "t.timeline", categoryColors: { Peace: "#00ff00" } };
  cache = new TimelineCache(app as never, () => settings);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("getXml", () => {
  it("parses once per mtime, re-parses after a change, and can be invalidated", async () => {
    const f = app.vault.seed("t.timeline", XML, 10);
    const spy = vi.spyOn(app.vault, "read");
    const a = await cache.getXml("t.timeline");
    expect(await cache.getXml("t.timeline")).toBe(a);
    expect(spy).toHaveBeenCalledTimes(1);
    f.stat.mtime = 11;
    expect(await cache.getXml("t.timeline")).not.toBe(a);
    cache.invalidateXml("t.timeline");
    await cache.getXml("t.timeline");
    expect(spy).toHaveBeenCalledTimes(3);
    cache.invalidateXml();
    await cache.getXml("t.timeline");
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("throws when the file is missing or is a folder", async () => {
    app.vault.mkdirs("folder");
    await expect(cache.getXml("nope.timeline")).rejects.toThrow("XML not found: nope.timeline");
    await expect(cache.getXml("folder")).rejects.toThrow("XML not found: folder");
  });
});

describe("event index", () => {
  const withNotes = () => {
    app.vault.seed("Events/a.md", note("a", "A"));
    app.index("Events/a.md", { timeline_event_id: "a" });
    app.vault.seed("Events/nested/b.md");
    app.index("Events/nested/b.md", { timeline: { event_id: "b" } });
    app.vault.seed("Events/c.md");
    app.index("Events/c.md", { timeline: [1] });
    app.vault.seed("Events/d.md");
    app.index("Events/d.md", { timeline: { event_id: 5 } });
    app.vault.seed("Events/e.md");
    app.vault.seed("Elsewhere/f.md");
    app.index("Elsewhere/f.md", { timeline_event_id: "f" });
    app.vault.seed("Events", "");
  };

  it("resolves ids from the mirror property or the nested field, inside the notes folder only", () => {
    withNotes();
    expect(cache.resolvePath("a")).toBe("Events/a.md");
    expect(cache.resolvePath("b")).toBe("Events/nested/b.md");
    expect(cache.resolvePath("f")).toBeNull();
    expect(cache.resolvePath("c")).toBeNull();
  });

  it("rebuilds on a miss only after the cooldown", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    cache.buildIndex();
    cache.buildIndex(); // idempotent
    app.vault.seed("Events/late.md");
    app.index("Events/late.md", { timeline_event_id: "late" });
    expect(cache.resolvePath("late")).toBeNull();
    vi.setSystemTime(105_000);
    expect(cache.resolvePath("late")).toBe("Events/late.md");
    expect(cache.resolvePath("never")).toBeNull(); // just rebuilt: no second rebuild yet
    vi.setSystemTime(110_000);
    expect(cache.resolvePath("never")).toBeNull(); // cooled down: rebuilt, still absent
  });

  it("builds an empty index when no notes folder is configured", () => {
    settings.eventNotesDir = "";
    app.vault.seed("x.md");
    expect(cache.resolvePath("x")).toBeNull();
    cache.updateFile("x.md"); // index built, but no dir: nothing to do
  });

  it("keeps the index current as files change and disappear", () => {
    cache.updateFile("Events/a.md"); // before the index exists: ignored
    cache.removeFile("Events/a.md");
    cache.buildIndex();
    app.vault.seed("Events/a.md");
    app.index("Events/a.md", { timeline_event_id: "a" });
    cache.updateFile("Events/a.md");
    expect(cache.resolvePath("a")).toBe("Events/a.md");
    app.index("Events/a.md", { timeline_event_id: "a2" });
    cache.updateFile("Events/a.md");
    expect(cache.resolvePath("a2")).toBe("Events/a.md");
    expect(cache.resolvePath("a")).toBeNull();
    app.index("Events/a.md", undefined);
    cache.updateFile("Events/a.md");
    cache.updateFile("Elsewhere/a.md"); // outside the folder
    cache.updateFile("Events/ghost.md"); // not in the vault
    cache.updateFile("Events"); // a path equal to the folder is not a file
    cache.removeFile("Events/a.md");
    cache.removeFile("Events/never-indexed.md");
  });

  it("forgets an indexed note when it is removed", () => {
    app.vault.seed("Events/a.md");
    app.index("Events/a.md", { timeline_event_id: "a" });
    expect(cache.resolvePath("a")).toBe("Events/a.md");
    cache.removeFile("Events/a.md");
    expect(cache.resolvePath("a")).toBeNull();
  });

  it("resetIndex drops everything including the markdown doc", async () => {
    app.vault.seed("Events/a.md", note("a", "A"));
    await cache.getMdDoc();
    cache.resetIndex();
    app.vault.seed("Events/b.md", note("b", "B"));
    expect((await cache.getMdDoc()).events).toHaveLength(2);
  });
});

describe("getMdDoc", () => {
  it("builds events, categories (with palette colours) and eras from notes, skipping junk", async () => {
    app.vault.seed("Events/a.md", note("a", "A"));
    app.vault.seed("Events/a2.md", note("a2", "A2"));
    app.vault.seed("Events/_eras/e.md", eraNote("e1"));
    app.vault.seed("Events/plain.md", "no frontmatter at all");
    app.vault.seed("Elsewhere/skip.md", note("z", "Z"));
    app.vault.seed("Events/uncategorised.md", "---\ntimeline:\n  enabled: true\n  start: {year: 1}\n  end: {year: 2}\n---\n# U\n");
    const bad = app.vault.seed("Events/bad.md", "x");
    vi.spyOn(app.vault, "cachedRead").mockImplementation(async (f) => {
      if (f === bad) throw new Error("unreadable");
      return app.vault.text(f.path);
    });
    const doc = await cache.getMdDoc();
    expect(doc.events.map((e) => e.id).sort()).toEqual(["a", "a2", "u"]);
    expect(doc.categories).toEqual([{ name: "Peace", color: "#00ff00" }]);
    expect(doc.eras?.map((e) => e.id)).toEqual(["e1"]);
    expect(doc).toMatchObject({ version: "md", timetype: "gregoriantime" });
  });

  it("returns eras undefined when there are none, and an empty doc with no folder configured", async () => {
    expect((await cache.getMdDoc()).eras).toBeUndefined();
    settings.eventNotesDir = "";
    cache.invalidateMdDoc();
    expect((await cache.getMdDoc()).events).toEqual([]);
  });

  it("caches for 30s, until invalidated", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    app.vault.seed("Events/a.md", note("a", "A"));
    const first = await cache.getMdDoc();
    app.vault.seed("Events/b.md", note("b", "B"));
    expect(await cache.getMdDoc()).toBe(first);
    vi.setSystemTime(1_031_000);
    expect((await cache.getMdDoc()).events).toHaveLength(2);
    app.vault.seed("Events/c.md", note("c", "C"));
    cache.invalidateMdDoc();
    expect((await cache.getMdDoc()).events).toHaveLength(3);
  });

  it("yields to the UI every 25 files", async () => {
    for (let i = 0; i < 30; i++) app.vault.seed(`Events/n${i}.md`, note(`n${i}`, `N${i}`));
    const spy = vi.spyOn(window, "setTimeout");
    expect((await cache.getMdDoc()).events).toHaveLength(30);
    expect(spy).toHaveBeenCalled();
  });
});

describe("getRenderDoc", () => {
  beforeEach(() => {
    app.vault.seed("t.timeline", XML, 5);
    app.vault.seed("Events/shared.md", note("shared", "MD version", "Peace"));
    app.vault.seed("Events/only.md", note("only", "Only in MD", "Peace"));
    app.vault.seed("Events/_eras/e.md", eraNote("xml-era"));
    app.vault.seed("Events/_eras/e2.md", eraNote("md-only-era"));
  });

  it("'xml' uses only the XML, and errors when it is missing", async () => {
    settings.eventSource = "xml";
    expect((await cache.getRenderDoc()).events.map((e) => e.id)).toEqual(["x1", "shared"]);
    settings.sourceXmlPath = "missing.timeline";
    await expect(cache.getRenderDoc()).rejects.toThrow("XML not found: missing.timeline");
    settings.sourceXmlPath = "";
    await expect(cache.getRenderDoc()).rejects.toThrow("XML not found");
  });

  it("'md' uses only the notes", async () => {
    settings.eventSource = "md";
    expect((await cache.getRenderDoc()).events.map((e) => e.id).sort()).toEqual(["only", "shared"]);
  });

  it("'auto' overlays notes on the XML: notes win by id, new ones append, categories and eras merge", async () => {
    settings.eventSource = "auto";
    const doc = await cache.getRenderDoc();
    expect(doc.events.map((e) => e.id).sort()).toEqual(["only", "shared", "x1"]);
    expect(doc.events.find((e) => e.id === "shared")?.text).toBe("MD version");
    expect(doc.categories.map((c) => c.name).sort()).toEqual(["Peace", "War"]);
    // The note with era_id "xml-era" replaces the XML's era of that id.
    expect(doc.eras?.map((e) => e.id).sort()).toEqual(["md-only-era", "xml-era"]);
    expect(doc.eras?.find((e) => e.id === "xml-era")?.name).toBe("MD era");
  });

  it("'auto' falls back to the notes when there is no XML, and keeps XML eras when notes have none", async () => {
    settings.eventSource = "auto";
    settings.sourceXmlPath = "missing.timeline";
    expect((await cache.getRenderDoc()).events).toHaveLength(2);
    settings.sourceXmlPath = "t.timeline";
    app.vault.remove("Events/_eras/e.md");
    app.vault.remove("Events/_eras/e2.md");
    cache.invalidateMdDoc();
    const doc = await cache.getRenderDoc();
    expect(doc.eras?.map((e) => e.name)).toEqual(["XML era"]);
  });

  it("'auto' tolerates an XML document that has no era list", async () => {
    settings.eventSource = "auto";
    const real = await cache.getXml("t.timeline");
    vi.spyOn(cache, "getXml").mockResolvedValue({ ...real, eras: undefined });
    const doc = await cache.getRenderDoc();
    expect(doc.eras?.map((e) => e.id).sort()).toEqual(["md-only-era", "xml-era"]);
    app.vault.remove("Events/_eras/e.md");
    app.vault.remove("Events/_eras/e2.md");
    cache.invalidateMdDoc();
    expect((await cache.getRenderDoc()).eras).toBeUndefined();
  });

  it("'auto' keeps a category the XML already has and works when neither side has eras", async () => {
    settings.eventSource = "auto";
    app.vault.remove("Events/_eras/e.md");
    app.vault.remove("Events/_eras/e2.md");
    app.vault.seed("Events/war.md", note("war", "War note", "War"));
    app.vault.seed("t.timeline", XML.replace(/<eras>[\s\S]*<\/eras>/, ""), 6);
    cache.invalidateMdDoc();
    const doc = await cache.getRenderDoc();
    expect(doc.categories.filter((c) => c.name === "War")).toHaveLength(1);
    expect(doc.eras).toEqual([]);
  });
});
