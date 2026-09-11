// @vitest-environment jsdom
import "./setup-obsidian-dom";
import { describe, expect, it, vi } from "vitest";
import { TimelineCache } from "../src/obsidian/cache";
import { DEFAULT_SETTINGS } from "../src/settings";

/** Minimal stand-ins for the bits of the Obsidian API the index touches. */
function fakeApp(files: { path: string; id: string | null }[]) {
  const tfiles = files.map((f) => Object.assign(Object.create(TFileProto), f));
  return {
    vault: {
      getMarkdownFiles: () => tfiles,
      getAbstractFileByPath: (p: string) =>
        tfiles.find((f) => f.path === p) ?? null,
    },
    metadataCache: {
      getFileCache: (f: { id: string | null }) =>
        f.id ? { frontmatter: { timeline: { event_id: f.id } } } : null,
    },
  };
}

// `instanceof TFile` is used by the cache; the stub only needs the prototype.
const TFileProto = Object.create(null);

describe("event id index", () => {
  const settings = () => ({
    ...DEFAULT_SETTINGS,
    eventNotesDir: "Timeline events",
  });

  it("rebuilds once when a lookup misses, so a cold metadata cache recovers", () => {
    // The first build sees no frontmatter at all — exactly what happens when
    // Obsidian has not parsed the notes yet.
    const files = [{ path: "Timeline events/a.md", id: null as string | null }];
    const app = fakeApp(files);
    const cache = new TimelineCache(app as never, settings);

    expect(cache.resolvePath("ev-1")).toBeNull();

    // Metadata arrives.
    files[0].id = "ev-1";
    (app.vault.getMarkdownFiles() as { id: string | null }[])[0].id = "ev-1";

    // Cooldown has not elapsed, so nothing is rebuilt yet...
    expect(cache.resolvePath("ev-1")).toBeNull();

    // ...but once it has, the next miss rebuilds and finds the note.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5000);
    expect(cache.resolvePath("ev-1")).toBe("Timeline events/a.md");
    vi.useRealTimers();
  });

  it("does not rebuild on every miss", () => {
    const app = fakeApp([{ path: "Timeline events/a.md", id: "ev-1" }]);
    const spy = vi.spyOn(app.vault, "getMarkdownFiles");
    const cache = new TimelineCache(app as never, settings);

    cache.resolvePath("ev-1");
    const afterFirst = spy.mock.calls.length;
    for (let i = 0; i < 10; i++) cache.resolvePath("missing");
    expect(spy.mock.calls.length).toBe(afterFirst);
  });
});
