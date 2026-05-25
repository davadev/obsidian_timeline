import { describe, it, expect } from "vitest";
import { applyRichFilter, type RichFilterState } from "../src/renderer/filter-bar";
import type { TimelineEvent } from "../src/timeline/model";

function ev(
  id: string,
  startY: number,
  endY: number,
  opts: Partial<TimelineEvent> = {}
): TimelineEvent {
  return {
    id,
    text: opts.text ?? id,
    start: { year: startY, month: 1, day: 1 },
    end: { year: endY, month: 1, day: 1 },
    isPoint: startY === endY,
    ...opts,
  };
}

function emptyState(overrides: Partial<RichFilterState> = {}): RichFilterState {
  return {
    hiddenCategories: new Set<string>(),
    search: "",
    labels: [],
    start: null,
    end: null,
    zoom: null,
    ...overrides,
  };
}

describe("applyRichFilter — shared filter", () => {
  it("keeps a point event inside a year-only range", () => {
    const events = [ev("p", -2200, -2200)];
    const state = emptyState({
      start: { year: -2300 },
      end: { year: -2000 },
    });
    const result = applyRichFilter(events, state);
    expect(result.map((e) => e.id)).toEqual(["p"]);
  });

  it("keeps a range event overlapping the filter range", () => {
    const events = [ev("r", -2400, -2100)];
    const state = emptyState({
      start: { year: -2300 },
      end: { year: -2000 },
    });
    const result = applyRichFilter(events, state);
    expect(result.map((e) => e.id)).toEqual(["r"]);
  });

  it("drops events entirely outside the filter range", () => {
    const events = [
      ev("before", -3000, -2400),
      ev("after-point", -1500, -1500),
    ];
    const state = emptyState({
      start: { year: -2300 },
      end: { year: -2000 },
    });
    const result = applyRichFilter(events, state);
    expect(result).toEqual([]);
  });

  it("handles open-ended range (only start)", () => {
    const events = [ev("p", -2200, -2200), ev("q", -1500, -1500)];
    const state = emptyState({ start: { year: -2000 } });
    const result = applyRichFilter(events, state);
    expect(result.map((e) => e.id)).toEqual(["q"]);
  });

  it("handles open-ended range (only end)", () => {
    const events = [ev("p", -2200, -2200), ev("q", -1500, -1500)];
    const state = emptyState({ end: { year: -2000 } });
    const result = applyRichFilter(events, state);
    expect(result.map((e) => e.id)).toEqual(["p"]);
  });

  it("applies search across title, description, category", () => {
    const events = [
      ev("a", 0, 0, { text: "Hello", description: "World" }),
      ev("b", 0, 0, { text: "Foo", category: "Kingdoms" }),
    ];
    const result = applyRichFilter(
      events,
      emptyState({ search: "kingdom" })
    );
    expect(result.map((e) => e.id)).toEqual(["b"]);
  });

  it("applies hidden categories", () => {
    const events = [
      ev("a", 0, 0, { category: "Kept" }),
      ev("b", 0, 0, { category: "Hidden" }),
    ];
    const result = applyRichFilter(
      events,
      emptyState({ hiddenCategories: new Set(["Hidden"]) })
    );
    expect(result.map((e) => e.id)).toEqual(["a"]);
  });

  it("applies label include filter", () => {
    const events = [
      ev("a", 0, 0, { labels: ["important", "key"] }),
      ev("b", 0, 0, { labels: ["misc"] }),
    ];
    const result = applyRichFilter(
      events,
      emptyState({ labels: ["important"] })
    );
    expect(result.map((e) => e.id)).toEqual(["a"]);
  });
});
