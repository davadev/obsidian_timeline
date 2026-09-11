// @vitest-environment jsdom
import "./setup-obsidian-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { renderTimeline } from "../src/renderer";
import type { TimelineEvent } from "../src/timeline/model";

beforeEach(() => {
  document.body.innerHTML = "";
});

function ev(id: string, startYear: number, endYear: number): TimelineEvent {
  return {
    id,
    text: `Event ${id}`,
    start: { year: startYear },
    end: { year: endYear },
    isPoint: startYear === endYear,
  } as TimelineEvent;
}

function renderAt(zoom: number): HTMLElement {
  const container = document.body.createDiv();
  // jsdom reports 0 for clientWidth; the renderer falls back to 800.
  renderTimeline({
    container,
    events: [ev("a", -900, -800), ev("b", 1000, 1200), ev("c", 1900, 2000)],
    categories: [],
    viewport: { start: { year: -900 }, end: { year: 2000 } },
    options: {
      mode: "bar",
      zoom,
      show: ["title"],
      details: "compact",
      showFilterUI: false,
      orientation: "horizontal",
      sort: "chronological",
    } as never,
    onOpenEvent: () => {},
    categoryColors: {},
    initialHidden: [],
    filterKey: "test",
    isMobile: false,
  });
  return container;
}

const labels = (el: HTMLElement) =>
  Array.from(el.querySelectorAll(".txs-axis-text")).map((n) => n.textContent ?? "");

describe("axis ticks follow the zoom", () => {
  it("adds marks as the axis grows", () => {
    const near = labels(renderAt(20));
    const far = labels(renderAt(1));
    expect(far.length).toBeGreaterThan(1);
    expect(near.length).toBeGreaterThan(far.length * 3);
  });

  it("uses finer calendar steps when zoomed in", () => {
    const far = labels(renderAt(1));
    const near = labels(renderAt(20));
    const gap = (ls: string[]) => {
      const years = ls.map((l) => (l.endsWith("BCE") ? -parseInt(l) : parseInt(l)));
      return Math.abs(years[1] - years[0]);
    };
    expect(gap(near)).toBeLessThan(gap(far));
  });
});
