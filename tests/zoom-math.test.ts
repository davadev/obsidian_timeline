import { describe, expect, it } from "vitest";
import {
  MAX_AXIS_PX,
  MAX_AXIS_PX_MOBILE,
  MAX_ZOOM,
  PinchTracker,
  clampAxisSize,
  MIN_ZOOM,
  ZOOM_STEP,
  clampZoom,
  focalScroll,
  formatZoom,
  maxZoomForAxis,
  wheelZoomFactor,
} from "../src/renderer/zoom-math";

describe("clampZoom", () => {
  it("keeps values inside the supported range", () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(MAX_ZOOM * 10)).toBe(MAX_ZOOM);
  });

  it("falls back to 1 for junk", () => {
    expect(clampZoom(NaN)).toBe(1);
    expect(clampZoom(Infinity)).toBe(MAX_ZOOM);
  });

  it("survives repeated stepping without drifting out of range", () => {
    let z = 1;
    for (let i = 0; i < 100; i++) z = clampZoom(z * ZOOM_STEP);
    expect(z).toBe(MAX_ZOOM);
    for (let i = 0; i < 100; i++) z = clampZoom(z / ZOOM_STEP);
    expect(z).toBe(MIN_ZOOM);
  });
});

describe("clampAxisSize", () => {
  it("keeps a sane floor and caps what the WebView must paint", () => {
    expect(clampAxisSize(800)).toBe(800);
    expect(clampAxisSize(10)).toBe(120);
    expect(clampAxisSize(1e9)).toBe(MAX_AXIS_PX);
  });

  it("caps the axis before the zoom limit is reached", () => {
    // a typical pane is ~800px wide; max zoom must not be able to outrun the
    // pixel cap unnoticed
    expect(clampAxisSize(800 * MAX_ZOOM)).toBe(MAX_AXIS_PX);
  });

  it("gives mobile a far smaller budget than the desktop", () => {
    // A multi-million-pixel SVG is a compositing layer iOS will not allocate;
    // it killed the app mid-gesture.
    expect(clampAxisSize(1e9, true)).toBe(MAX_AXIS_PX_MOBILE);
    expect(clampAxisSize(1e9, false)).toBe(MAX_AXIS_PX);
    expect(MAX_AXIS_PX_MOBILE * 4).toBeLessThan(MAX_AXIS_PX);
  });
});

describe("formatZoom", () => {
  it("shows one decimal below 10 and none above", () => {
    expect(formatZoom(1)).toBe("1");
    expect(formatZoom(1.35)).toBe("1.4");
    expect(formatZoom(1.4999999)).toBe("1.5");
    expect(formatZoom(12.4)).toBe("12");
  });
});

describe("focalScroll", () => {
  it("keeps the point under the cursor anchored", () => {
    // content at x=300 in the scroller's content box, cursor 100px in
    const scroll = 200;
    const focal = 100;
    const ratio = 2;
    const next = focalScroll(scroll, focal, ratio);
    // that content sits at (scroll + focal) * ratio after scaling; the cursor
    // must still land on it
    expect(next + focal).toBe((scroll + focal) * ratio);
  });

  it("never scrolls past the start", () => {
    expect(focalScroll(0, 50, 0.25)).toBe(0);
  });
});

describe("wheelZoomFactor", () => {
  it("zooms in when scrolling up and out when scrolling down", () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    expect(wheelZoomFactor(0)).toBe(1);
  });

  it("is symmetric, so a pinch in and back out returns to the start", () => {
    expect(wheelZoomFactor(-60) * wheelZoomFactor(60)).toBeCloseTo(1, 10);
  });
});

describe("PinchTracker", () => {
  const A = { x: 100, y: 100 };
  const B = { x: 200, y: 100 };
  const B_FAR = { x: 300, y: 100 };

  it("ignores a single finger", () => {
    const t = new PinchTracker();
    expect(t.start([A]).kind).toBe("none");
    expect(t.move([{ x: 150, y: 100 }]).kind).toBe("none");
    expect(t.active).toBe(false);
  });

  it("tracks a two-finger pinch and commits on release", () => {
    const t = new PinchTracker();
    const begun = t.start([A, B]);
    expect(begun).toEqual({ kind: "begin", focal: { x: 150, y: 100 } });

    const moved = t.move([A, B_FAR]);
    expect(moved.kind).toBe("update");
    if (moved.kind === "update") {
      expect(moved.scale).toBeCloseTo(2, 10); // 100px apart -> 200px apart
      expect(moved.focal).toEqual({ x: 200, y: 100 });
    }

    expect(t.end([A]).kind).toBe("commit");
    expect(t.active).toBe(false);
  });

  it("does not zoom on a pan after a release was missed", () => {
    const t = new PinchTracker();
    t.start([A, B]);
    // the WebView swallowed one release: we only ever see "no touches left"
    expect(t.end([]).kind).toBe("commit");
    // a later one-finger drag must scroll, not zoom
    expect(t.move([{ x: 160, y: 100 }]).kind).toBe("none");
    expect(t.move([A, B_FAR]).kind).toBe("none");
  });

  it("keeps pinching while a third finger lands and lifts", () => {
    const t = new PinchTracker();
    t.start([A, B]);
    expect(t.start([A, B, { x: 250, y: 250 }]).kind).toBe("none");
    expect(t.active).toBe(true);
    expect(t.end([A, B]).kind).toBe("none");
    expect(t.active).toBe(true);
    expect(t.end([A]).kind).toBe("commit");
  });

  it("commits only once", () => {
    const t = new PinchTracker();
    t.start([A, B]);
    expect(t.end([]).kind).toBe("commit");
    expect(t.end([]).kind).toBe("none");
  });
});

describe("maxZoomForAxis", () => {
  it("reports the honest ceiling for the pane, not the absolute maximum", () => {
    // A phone pane: 390px of axis against the mobile pixel cap.
    const phone = maxZoomForAxis(390, true);
    expect(phone).toBeCloseTo(MAX_AXIS_PX_MOBILE / 390, 5);
    expect(phone).toBeLessThan(MAX_ZOOM);

    // The same pane on desktop can go much deeper.
    expect(maxZoomForAxis(390, false)).toBeGreaterThan(phone * 5);
  });

  it("never exceeds the absolute zoom limit for a tiny pane", () => {
    expect(maxZoomForAxis(1, false)).toBe(MAX_ZOOM);
  });

  it("stays usable for an implausibly wide pane", () => {
    expect(maxZoomForAxis(1e9, true)).toBe(MIN_ZOOM);
  });

  it("matches what the renderer will actually draw", () => {
    const base = 390;
    const ceiling = maxZoomForAxis(base, true);
    // at the ceiling the axis is exactly the cap; beyond it, nothing grows
    expect(clampAxisSize(base * ceiling, true)).toBe(MAX_AXIS_PX_MOBILE);
    expect(clampAxisSize(base * ceiling * 4, true)).toBe(MAX_AXIS_PX_MOBILE);
  });
});
