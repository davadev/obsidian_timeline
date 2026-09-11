// @vitest-environment jsdom
import "./setup-obsidian-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { WindowedChart } from "../src/renderer/windowed-chart";
import type { TimelineEvent } from "../src/timeline/model";

const PANE = 800;

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

/** A chart over ~2900 years, sized as a desktop pane. */
function chartAt(zoom: number): { chart: WindowedChart; scroller: HTMLElement } {
  const container = document.body.createDiv();
  const chart = new WindowedChart({
    container,
    categories: [],
    categoryColors: {},
    orientation: "horizontal",
    isMobile: false,
    onOpenEvent: () => {},
  });
  const scroller = container.querySelector(".txs-chart") as HTMLElement;
  Object.defineProperty(scroller, "clientWidth", {
    value: PANE,
    configurable: true,
  });
  chart.setData(
    [ev("a", -900, -800), ev("b", 1000, 1200), ev("c", 1900, 2000)],
    [],
    { start: { year: -900 }, end: { year: 2000 } },
    zoom
  );
  return { chart, scroller };
}

const marks = (scroller: HTMLElement): string[] =>
  Array.from(scroller.querySelectorAll(".txs-tile-host .txs-axis-text")).map(
    (n) => n.textContent ?? ""
  );

describe("axis ticks follow the zoom", () => {
  it("keeps the mark count flat while the step gets finer", () => {
    expect(marks(chartAt(1).scroller).length).toBeGreaterThan(1);

    // Only the tiles in the ring are labelled — at most five of them — so the
    // count is bounded however deep the zoom goes. The old whole-axis approach
    // grew with the zoom until a cap truncated the far end of the timeline.
    const near = marks(chartAt(2_000).scroller).length;
    const deeper = marks(chartAt(2_000_000).scroller).length;
    expect(near).toBeLessThan(60);
    expect(deeper).toBeLessThan(60);
  });

  it("uses finer calendar steps when zoomed in", () => {
    const yearsApart = (labels: string[]): number => {
      const years = labels
        .filter((l) => /^\d+( BCE)?$/.test(l))
        .map((l) => (l.endsWith("BCE") ? -parseInt(l) : parseInt(l)));
      return Math.abs(years[1] - years[0]);
    };
    expect(yearsApart(marks(chartAt(40).scroller))).toBeLessThan(
      yearsApart(marks(chartAt(1).scroller))
    );
  });

  it("names months, then days, as the window narrows", () => {
    // ~2900 years of data: a window of a few years names months...
    const months = marks(chartAt(1_000).scroller);
    expect(months.some((l) => /^[A-Z][a-z]{2} \d+/.test(l))).toBe(true);

    // ...and a window of about a month names days.
    const days = marks(chartAt(35_000).scroller);
    expect(days.some((l) => /^\d+ [A-Z][a-z]{2} \d+$/.test(l))).toBe(true);
  });

  it("reaches the hour floor, which the old pixel-capped axis could not", () => {
    // A window of roughly a day on this span.
    const { chart, scroller } = chartAt(1_100_000);
    expect(chart.zoom).toBeGreaterThan(1_000_000);
    expect(marks(scroller).some((l) => /^\d{2}:\d{2}$/.test(l))).toBe(true);
  });
});
