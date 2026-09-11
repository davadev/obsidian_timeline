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

const anchor = (wrapper: HTMLElement) =>
  wrapper.querySelector(".txs-label-anchor") as SVGGElement | null;

const px = (el: Element, prop: string) =>
  Number.parseFloat((el as SVGGElement).style.getPropertyValue(prop));

describe("sticky event labels", () => {
  it("hands the label's own bounds to CSS", () => {
    const wrapper = render(true);
    const g = anchor(wrapper);
    expect(g).not.toBeNull();

    const rect = wrapper.querySelector(".txs-event-bar") as unknown as SVGRectElement;
    const barFrom = Number(rect.getAttribute("x"));
    const barTo = barFrom + Number(rect.getAttribute("width"));

    // the label may travel from the start of its bar up to (end - its width)
    expect(px(g!, "--txs-from")).toBeCloseTo(barFrom, 0);
    expect(px(g!, "--txs-latest")).toBeGreaterThanOrEqual(px(g!, "--txs-from"));
    expect(px(g!, "--txs-latest")).toBeLessThan(barTo);
    expect(wrapper.classList.contains("is-sticky-labels")).toBe(true);
  });

  it("publishes the scroll offset once per frame, not per label", async () => {
    const wrapper = render(true);
    Object.defineProperty(wrapper, "clientWidth", { value: 400, configurable: true });

    wrapper.scrollLeft = 2500;
    wrapper.dispatchEvent(new Event("scroll"));
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    expect(wrapper.style.getPropertyValue("--txs-scroll")).toBe("2500px");
    // the group itself is untouched by scrolling — CSS does the clamping
    expect(anchor(wrapper)!.getAttribute("transform")).toContain("translate");
  });

  it("leaves labels pinned when the option is off", () => {
    const wrapper = render(false);
    expect(anchor(wrapper)).toBeNull();
    expect(wrapper.classList.contains("is-sticky-labels")).toBe(false);
  });
});
