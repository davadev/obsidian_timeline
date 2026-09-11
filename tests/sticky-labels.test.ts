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

/** Scroll, then let the settle timer and its frame run. */
async function scrollTo(wrapper: HTMLElement, x: number): Promise<void> {
  Object.defineProperty(wrapper, "clientWidth", { value: 400, configurable: true });
  wrapper.scrollLeft = x;
  wrapper.dispatchEvent(new Event("scroll"));
  await new Promise((r) => setTimeout(r, 150));
  await new Promise((r) => requestAnimationFrame(() => r(null)));
}

describe("sticky event labels", () => {
  it("slides the label into view once scrolling settles", async () => {
    const wrapper = render(true);
    const start = labelX(wrapper);
    await scrollTo(wrapper, 2500);
    const moved = labelX(wrapper);
    expect(moved).toBeGreaterThan(start);
    expect(moved).toBeGreaterThanOrEqual(2500);
  });

  it("never pushes the label past the end of its own bar", async () => {
    const wrapper = render(true);
    const rect = wrapper.querySelector(".txs-event-bar") as unknown as SVGRectElement;
    const barEnd =
      Number(rect.getAttribute("x")) + Number(rect.getAttribute("width"));
    await scrollTo(wrapper, 100000);
    expect(labelX(wrapper)).toBeLessThanOrEqual(barEnd);
  });

  it("leaves labels pinned when the option is off", async () => {
    const wrapper = render(false);
    const start = labelX(wrapper);
    await scrollTo(wrapper, 2500);
    expect(labelX(wrapper)).toBe(start);
  });
});
