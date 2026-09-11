// @vitest-environment jsdom
import "./setup-obsidian-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { renderBar } from "../src/renderer/bar-renderer";
import type { TimelineEvent } from "../src/timeline/model";

beforeEach(() => {
  document.body.innerHTML = "";
});

function span(id: string, from: number, to: number): TimelineEvent {
  return {
    id,
    text: `${id} span`,
    start: { year: from },
    end: { year: to },
    isPoint: false,
  } as TimelineEvent;
}

function render(stickyLabels: boolean): HTMLElement {
  const container = document.body.createDiv();
  return renderBar({
    container,
    events: [span("a", 1000, 1900)],
    categories: [],
    viewport: { start: { year: 900 }, end: { year: 2000 } },
    categoryColors: {},
    onOpenEvent: () => {},
    zoom: 20,
    orientation: "horizontal",
    isMobile: false,
    stickyLabels,
  });
}

/** Translate x of the group wrapping the single event label. */
function labelX(wrapper: HTMLElement): number {
  const text = wrapper.querySelector(".txs-event-label");
  const g = text?.parentElement as unknown as SVGGElement;
  const m = /translate\(([-\d.]+)/.exec(g.getAttribute("transform") ?? "");
  return m ? Number(m[1]) : NaN;
}

describe("sticky event labels", () => {
  it("slides the label to the visible edge of a scrolled bar", async () => {
    const wrapper = render(true);
    const start = labelX(wrapper);

    // jsdom has no layout, so drive the scroll state the handler reads.
    Object.defineProperty(wrapper, "clientWidth", { value: 400, configurable: true });
    wrapper.scrollLeft = 2000;
    wrapper.dispatchEvent(new Event("scroll"));
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const moved = labelX(wrapper);
    expect(moved).toBeGreaterThan(start);
    expect(moved).toBeGreaterThanOrEqual(2000);
  });

  it("never pushes the label past the end of its own bar", async () => {
    const wrapper = render(true);
    const rect = wrapper.querySelector(".txs-event-bar") as unknown as SVGRectElement;
    const barEnd =
      Number(rect.getAttribute("x")) + Number(rect.getAttribute("width"));

    Object.defineProperty(wrapper, "clientWidth", { value: 400, configurable: true });
    wrapper.scrollLeft = 100000; // far past the bar
    wrapper.dispatchEvent(new Event("scroll"));
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    expect(labelX(wrapper)).toBeLessThanOrEqual(barEnd);
  });

  it("leaves labels pinned when the option is off", async () => {
    const wrapper = render(false);
    const start = labelX(wrapper);

    Object.defineProperty(wrapper, "clientWidth", { value: 400, configurable: true });
    wrapper.scrollLeft = 2000;
    wrapper.dispatchEvent(new Event("scroll"));
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    expect(labelX(wrapper)).toBe(start);
  });
});
