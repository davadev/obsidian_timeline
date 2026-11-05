import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debounce, mergeNotesIntoDoc } from "../src/timeline/sync-engine";
import type { EventNote, TimelineDoc, TimelineEvent } from "../src/timeline/model";

const date = { year: 2000, month: 1, day: 1 };
const ev = (id: string, extra: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id,
  text: id,
  start: date,
  end: date,
  isPoint: true,
  ...extra,
});
const note = (event: TimelineEvent): EventNote => ({
  event,
  location: { path: `${event.id}.md` },
  extraFrontmatter: {},
  body: "",
  mirrors: {},
});

describe("mergeNotesIntoDoc", () => {
  const doc: TimelineDoc = {
    categories: [{ name: "War", color: "1,2,3" }],
    events: [ev("a", { raw: { keep: "me" } }), ev("gone")],
  };

  it("keeps raw for known ids, appends new events, drops events missing from Markdown", () => {
    const out = mergeNotesIntoDoc(doc, [note(ev("a", { text: "edited" })), note(ev("b"))]);
    expect(out.events.map((e) => e.id)).toEqual(["a", "b"]);
    expect(out.events[0]).toMatchObject({ text: "edited", raw: { keep: "me" } });
    expect(out.events[1].raw).toBeUndefined();
  });

  it("appends categories that Markdown references but the XML lacks, once", () => {
    const out = mergeNotesIntoDoc(doc, [
      note(ev("a", { category: "War" })),
      note(ev("b", { category: "Peace" })),
      note(ev("c", { category: "Peace" })),
      note(ev("d")),
    ]);
    expect(out.categories.map((c) => c.name)).toEqual(["War", "Peace"]);
    expect(out.categories[1].color).toBe("200,200,200");
  });
});

describe("debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("fires once, with the last arguments, after the quiet period", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d(1);
    vi.advanceTimersByTime(50);
    d(2);
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(2);
  });
});
