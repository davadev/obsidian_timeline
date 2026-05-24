import { describe, it, expect } from "vitest";
import {
  assignLanes,
  eventOverlapsViewport,
  eventsInViewport,
} from "../src/timeline/overlap";
import type { TimelineEvent } from "../src/timeline/model";

function ev(
  id: string,
  startY: number,
  endY: number,
  isPoint = false
): TimelineEvent {
  return {
    id,
    text: id,
    start: { year: startY, month: 1, day: 1 },
    end: { year: endY, month: 1, day: 1 },
    isPoint,
  };
}

describe("overlap", () => {
  it("filters events in viewport", () => {
    const events = [
      ev("a", -200, -100),
      ev("b", -50, 50),
      ev("c", 100, 200),
      ev("p", 25, 25, true),
    ];
    const inView = eventsInViewport(events, {
      start: { year: -75 },
      end: { year: 75 },
    });
    expect(inView.map((e) => e.id)).toEqual(["b", "p"]);
  });

  it("supports BCE viewport", () => {
    const e = ev("x", -500, -300);
    expect(
      eventOverlapsViewport(e, { start: { year: -600 }, end: { year: -400 } })
    ).toBe(true);
    expect(
      eventOverlapsViewport(e, { start: { year: -200 }, end: { year: -100 } })
    ).toBe(false);
  });

  it("assigns lanes greedily to avoid overlap", () => {
    const events = [
      ev("a", 0, 10),
      ev("b", 5, 15),
      ev("c", 20, 30),
    ];
    const lanes = assignLanes(events);
    // a and b overlap → different lanes
    expect(lanes[0]).not.toBe(lanes[1]);
    // c does not overlap a/b — reuses lane 0
    expect(lanes[2]).toBe(0);
    // total lanes used must be exactly 2
    expect(new Set(lanes).size).toBe(2);
  });

  it("uses minimal lanes for non-overlapping events regardless of input order", () => {
    const events = [
      ev("a", 0, 10),
      ev("b", 11, 20),
      ev("c", 21, 30),
    ];
    const lanes = assignLanes(events);
    expect(new Set(lanes).size).toBe(1);
  });
});
