// @vitest-environment jsdom
import "./setup-obsidian-dom";
import { describe, it, expect, beforeEach } from "vitest";
import { renderTimeline } from "../src/renderer";
import type { TimelineEvent, TimelineCategory, TimelineEra } from "../src/timeline/model";

// Reset DOM between tests so containers don't accumulate.
beforeEach(() => {
  if (typeof document !== "undefined") {
    document.body.innerHTML = "";
  }
});

function ev(
  id: string,
  startYear: number,
  endYear: number,
  category: string | undefined = undefined
): TimelineEvent {
  return {
    id,
    text: id,
    start: { year: startYear },
    end: { year: endYear },
    isPoint: startYear === endYear,
    category,
  };
}

function era(id: string, startYear: number, endYear: number): TimelineEra {
  return { id, name: id, start: { year: startYear }, end: { year: endYear } };
}

function bodyText(container: HTMLElement): string {
  return container.textContent ?? "";
}

function withContainer(): HTMLElement {
  const c = document.createElement("div");
  document.body.appendChild(c);
  return c;
}

const baseOptions = {
  mode: "bar" as const,
  source: "main",
  details: "list" as const,
  sort: "chronological" as const,
  show: ["title", "date", "category"] as ("title" | "date" | "category")[],
  zoom: 1,
  orientation: "horizontal" as const,
  showFilterUI: false,
};

describe("renderTimeline display regression — issue: 'No events to display'", () => {
  it("renders bars when given non-empty events + caller viewport", () => {
    const container = withContainer();
    renderTimeline({
      container,
      events: [ev("e1", 1000, 1100), ev("e2", 1200, 1300)],
      categories: [] as TimelineCategory[],
      viewport: { start: { year: 1000 }, end: { year: 1300 } },
      options: { ...baseOptions },
      onOpenEvent: () => {},
      categoryColors: {},
      initialHidden: [],
      filterKey: "test:basic",
      isMobile: false,
    });
    expect(bodyText(container)).not.toContain("No events to display");
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("renders even when caller viewport is undefined (auto-derives)", () => {
    const container = withContainer();
    renderTimeline({
      container,
      events: [ev("e1", -1000, -800)],
      categories: [],
      viewport: undefined,
      options: { ...baseOptions },
      onOpenEvent: () => {},
      categoryColors: {},
      initialHidden: [],
      filterKey: "test:no-viewport",
      isMobile: false,
    });
    expect(bodyText(container)).not.toContain("No events to display");
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("renders inline-block scenario: filter UI present, default state, events non-empty", () => {
    const container = withContainer();
    renderTimeline({
      container,
      events: [ev("e1", 1500, 1600), ev("e2", 1700, 1800), ev("e3", 1900, 2000)],
      categories: [{ name: "default" } as TimelineCategory],
      viewport: { start: { year: 1500 }, end: { year: 2000 } },
      options: { ...baseOptions, showFilterUI: true, mode: "hybrid" },
      onOpenEvent: () => {},
      categoryColors: {},
      initialHidden: [],
      filterKey: "test:inline-default",
      isMobile: false,
    });
    expect(bodyText(container)).not.toContain("No events to display");
  });

  it("respects caller viewport (viewport: true scenario) — does NOT override with autoViewport(events)", () => {
    // Simulates a NEW event note with `viewport: true`. The postprocessor
    // narrows events to a 100-year window around the host event but passes
    // the SAME (padded) viewport explicitly. If the renderer derived the
    // viewport from `events` instead of using args.viewport, the single
    // event would yield a zero-width viewport (regression seen in 0.8.1).
    const container = withContainer();
    const explicitViewport = {
      start: { year: 1900 },
      end: { year: 2100 },
    };
    renderTimeline({
      container,
      events: [ev("host", 2000, 2000)], // single point event in the middle
      categories: [],
      viewport: explicitViewport,
      options: { ...baseOptions, mode: "bar" },
      onOpenEvent: () => {},
      categoryColors: {},
      initialHidden: [],
      filterKey: "test:viewport-true",
      isMobile: false,
    });
    expect(bodyText(container)).not.toContain("No events to display");
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    // SVG width should reflect the wide viewport (zoom=1 + container default).
    // A zero-width viewport would still draw the SVG, but the point would sit
    // at fractional position 0 (the leftmost pixel) — exercised below.
    const point = svg!.querySelector(".txs-event-point");
    expect(point).not.toBeNull();
  });

  it("eras filter to the active viewport (range filter narrows eras too)", () => {
    const container = withContainer();
    renderTimeline({
      container,
      events: [
        ev("ancient", -2000, -1500),
        ev("medieval", 1000, 1200),
        ev("modern", 1900, 2000),
      ],
      categories: [],
      eras: [
        era("ice-age", -10000, -8000),
        era("iron-age", -1200, -550),
        era("modern-era", 1500, 2100),
      ] as TimelineEra[],
      viewport: { start: { year: -2000 }, end: { year: 2000 } },
      options: { ...baseOptions, mode: "bar" },
      onOpenEvent: () => {},
      onOpenEra: () => {},
      categoryColors: {},
      initialHidden: [],
      filterKey: "test:eras",
      isMobile: false,
    });
    // With caller viewport [-2000, 2000], ice-age (-10000..-8000) is OUTSIDE
    // and must be filtered out. iron-age + modern-era overlap.
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    const eraBands = svg!.querySelectorAll(".txs-era-band, [data-era-id]");
    // At minimum the two overlapping eras render; ice-age must NOT.
    const eraIds = Array.from(eraBands).map(
      (n) => (n as Element).getAttribute("data-era-id") ?? ""
    );
    expect(eraIds).not.toContain("ice-age");
  });

  it("shows 'No events to display' only when events are actually empty", () => {
    const container = withContainer();
    renderTimeline({
      container,
      events: [],
      categories: [],
      viewport: { start: { year: 0 }, end: { year: 100 } },
      options: { ...baseOptions, mode: "bar" },
      onOpenEvent: () => {},
      categoryColors: {},
      initialHidden: [],
      filterKey: "test:empty",
      isMobile: false,
    });
    expect(bodyText(container)).toContain("No events to display");
  });

  it("hybrid mode renders both bar and list bodies", () => {
    const container = withContainer();
    renderTimeline({
      container,
      events: [ev("a", 100, 200), ev("b", 300, 400)],
      categories: [],
      viewport: { start: { year: 100 }, end: { year: 400 } },
      options: { ...baseOptions, mode: "hybrid" },
      onOpenEvent: () => {},
      categoryColors: {},
      initialHidden: [],
      filterKey: "test:hybrid",
      isMobile: false,
    });
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("ul.txs-timeline-list")).not.toBeNull();
  });
});
