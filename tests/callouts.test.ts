import { describe, expect, it } from "vitest";
import {
  layoutCallouts,
  type CalloutItem,
  type LaneSpan,
} from "../src/renderer/callouts";

/** One character is one unit wide here, so the arithmetic stays readable. */
const opts = { measure: (t: string) => t.length, gap: 1, leader: 2, minChars: 4, pointRadius: 2, edgePad: 0 };

const point = (id: string, at: number, lane = 0): CalloutItem => ({
  id,
  text: id,
  lane,
  startPx: at,
  endPx: at,
  isPoint: true,
});

const bar = (id: string, from: number, to: number, lane = 0): CalloutItem => ({
  id,
  text: id,
  lane,
  startPx: from,
  endPx: to,
  isPoint: false,
});

const span = (lane: number, from: number, to: number): LaneSpan => ({ lane, from, to });

describe("callout placement", () => {
  it("puts the name after the event, past the leader", () => {
    const [out] = layoutCallouts([point("D-Day", 100)], [span(0, 98, 102)], 400, opts);
    expect(out.side).toBe("after");
    expect(out.anchorPx).toBe(102); // the edge of the marker, not its centre
    expect(out.textPx).toBe(104); // leader clears it
    expect(out.label).toBe("D-Day");
  });

  it("never puts a name on top of something already painted", () => {
    // A bar sits immediately to the right, so the only room is to the left.
    const out = layoutCallouts(
      [point("Cobra", 100)],
      [span(0, 98, 102), span(0, 103, 300)],
      400,
      opts
    );
    expect(out).toHaveLength(1);
    expect(out[0].side).toBe("before");
    expect(out[0].textPx + out[0].widthPx).toBeLessThanOrEqual(98 - 2);
  });

  it("leaves an event unnamed rather than overlapping when boxed in", () => {
    // Painted hard against the marker on both sides.
    const out = layoutCallouts(
      [point("Cobra", 100)],
      [span(0, 0, 99), span(0, 101, 400)],
      400,
      opts
    );
    expect(out).toEqual([]);
  });

  it("keeps names out of each other's way inside one lane", () => {
    const out = layoutCallouts(
      [point("Alpha", 100), point("Bravo", 112)],
      [span(0, 98, 102), span(0, 110, 114)],
      400,
      opts
    );
    const boxes = out.map((c) => [c.textPx, c.textPx + c.widthPx]);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const overlap =
          Math.min(boxes[i][1], boxes[j][1]) - Math.max(boxes[i][0], boxes[j][0]);
        expect(overlap).toBeLessThanOrEqual(0);
      }
    }
  });

  it("ignores what is painted in other lanes", () => {
    const out = layoutCallouts(
      [point("Cobra", 100, 1)],
      [span(1, 98, 102), span(0, 0, 400), span(2, 0, 400)],
      400,
      opts
    );
    expect(out).toHaveLength(1);
  });

  it("truncates to the room there is", () => {
    // 10 units of clear space to the right, then a bar.
    const [out] = layoutCallouts(
      [point("Operation Bagration", 100)],
      [span(0, 98, 102), span(0, 115, 300)],
      400,
      opts
    );
    expect(out.label.endsWith("…")).toBe(true);
    expect(out.widthPx).toBeLessThanOrEqual(115 - 1 - 104);
  });

  it("would rather say nothing than say three characters", () => {
    // Four units of room each way: less than the shortest useful form.
    const out = layoutCallouts(
      [point("Operation Bagration", 100)],
      [span(0, 0, 94), span(0, 98, 102), span(0, 108, 300)],
      400,
      opts
    );
    expect(out).toEqual([]);
  });

  it("gives a contested gap to the event that needs it most", () => {
    // One gap, and both bars reach it — the short one from the left, the long
    // one from the right. The short one has the stronger claim: a wide bar can
    // often hold its name itself, a narrow one never can.
    const short = { ...bar("short-bar-name", 60, 100), text: "short-bar-name" };
    const long = { ...bar("long-bar-name", 130, 260), text: "long-bar-name" };
    const out = layoutCallouts(
      [long, short],
      [span(0, 60, 100), span(0, 130, 260)],
      400,
      opts
    );
    const placed = new Map(out.map((c) => [c.id, c]));
    expect(placed.get("short-bar-name")?.label).toBe("short-bar-name");
    expect(placed.get("short-bar-name")?.side).toBe("after");
  });

  it("stays inside the pane", () => {
    const [out] = layoutCallouts([point("Yalta", 390)], [span(0, 388, 392)], 400, {
      ...opts,
      edgePad: 2,
    });
    expect(out.textPx).toBeGreaterThanOrEqual(2);
    expect(out.textPx + out.widthPx).toBeLessThanOrEqual(398);
  });

  it("reads left to right whatever order it placed them in", () => {
    const out = layoutCallouts(
      [point("late", 300), point("early", 100)],
      [span(0, 298, 302), span(0, 98, 102)],
      400,
      opts
    );
    expect(out.map((c) => c.id)).toEqual(["early", "late"]);
  });
});
