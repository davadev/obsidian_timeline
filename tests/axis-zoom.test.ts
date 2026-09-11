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

/**
 * Marks are painted for the visible window on the next frame, so the test has
 * to give the wrapper a size and let that frame run.
 */
async function labels(el: HTMLElement, viewWidth = 800): Promise<string[]> {
  const wrapper = el.querySelector(".txs-timeline-bar") as HTMLElement;
  Object.defineProperty(wrapper, "clientWidth", {
    value: viewWidth,
    configurable: true,
  });
  wrapper.dispatchEvent(new Event("scroll"));
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  return Array.from(el.querySelectorAll(".txs-axis-text")).map(
    (n) => n.textContent ?? ""
  );
}

describe("axis ticks follow the zoom", () => {
  it("keeps the mark count flat while the step gets finer", async () => {
    // Only the visible window is labelled, so the node count must NOT grow
    // with the zoom — that is what used to force a cap and truncate the axis.
    const far = await labels(renderAt(1));
    const near = await labels(renderAt(200));
    expect(far.length).toBeGreaterThan(1);
    expect(near.length).toBeLessThan(far.length * 3);
  });

  it("uses finer calendar steps when zoomed in", async () => {
    const far = await labels(renderAt(1));
    const near = await labels(renderAt(20));
    const gap = (ls: string[]) => {
      const years = ls.map((l) =>
        l.endsWith("BCE") ? -parseInt(l) : parseInt(l)
      );
      return Math.abs(years[1] - years[0]);
    };
    expect(gap(near)).toBeLessThan(gap(far));
  });

  it("names months once the axis is wide enough for them", async () => {
    const marks = await labels(renderAt(1500));
    expect(marks.some((l) => /^[A-Z][a-z]{2} /.test(l))).toBe(true);
  });
});
