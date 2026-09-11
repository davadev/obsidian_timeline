import { describe, expect, it } from "vitest";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEP,
  clampZoom,
  focalScroll,
  formatZoom,
  wheelZoomFactor,
} from "../src/renderer/zoom-math";

describe("clampZoom", () => {
  it("keeps values inside the supported range", () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(1000)).toBe(MAX_ZOOM);
  });

  it("falls back to 1 for junk", () => {
    expect(clampZoom(NaN)).toBe(1);
    expect(clampZoom(Infinity)).toBe(MAX_ZOOM);
  });

  it("survives repeated stepping without drifting out of range", () => {
    let z = 1;
    for (let i = 0; i < 50; i++) z = clampZoom(z * ZOOM_STEP);
    expect(z).toBe(MAX_ZOOM);
    for (let i = 0; i < 100; i++) z = clampZoom(z / ZOOM_STEP);
    expect(z).toBe(MIN_ZOOM);
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
