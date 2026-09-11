/**
 * Pure zoom arithmetic shared by the timeline view's pinch gesture, its
 * ctrl+wheel handler and its +/- buttons. Kept free of DOM so it can be
 * tested directly.
 */

/** Below this the bars are unreadable; above it the SVG gets absurd. */
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 50;
/** Multiplier applied by one press of +/-. */
export const ZOOM_STEP = 1.35;

export function clampZoom(z: number): number {
  if (Number.isNaN(z)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/** "1.5" / "12" rather than "1.4999999" / "12.0". */
export function formatZoom(z: number): string {
  return z >= 10 ? String(Math.round(z)) : String(Math.round(z * 10) / 10);
}

/**
 * New scroll offset that keeps the content under `focal` (px from the
 * scroller's leading edge) in place while the canvas scales by `ratio`.
 */
export function focalScroll(scroll: number, focal: number, ratio: number): number {
  return Math.max(0, (scroll + focal) * ratio - focal);
}

/** Trackpad pinch and ctrl+wheel arrive as wheel deltas; map them to a factor. */
export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(-deltaY / 180);
}

export interface PinchPoint {
  x: number;
  y: number;
}

export type PinchAction =
  | { kind: "none" }
  | { kind: "begin"; focal: PinchPoint }
  | { kind: "update"; scale: number; focal: PinchPoint }
  | { kind: "commit" };

const NONE: PinchAction = { kind: "none" };

/**
 * Turns raw touch-point lists into pinch actions.
 *
 * Every method takes the touches that are *currently down*, straight from the
 * event, and the tracker keeps no ids of its own. That is the whole point: a
 * tracker that remembers pointer ids can miss a release (the WebView swallows
 * one when it takes over a scroll) and then read the next one-finger pan as a
 * pinch, zooming when the user meant to scroll.
 */
export class PinchTracker {
  private startSpread = 0;

  get active(): boolean {
    return this.startSpread > 0;
  }

  /** A touch went down. */
  start(touches: PinchPoint[]): PinchAction {
    if (touches.length === 2) {
      this.startSpread = spread(touches);
      return { kind: "begin", focal: midpoint(touches) };
    }
    // Any other count (one finger, or a third landing) is not a pinch.
    return this.stop(touches);
  }

  /** A touch moved. */
  move(touches: PinchPoint[]): PinchAction {
    if (!this.active || touches.length !== 2) return NONE;
    const now = spread(touches);
    if (now <= 0) return NONE;
    return { kind: "update", scale: now / this.startSpread, focal: midpoint(touches) };
  }

  /** A touch was lifted or cancelled; `touches` is what remains down. */
  end(touches: PinchPoint[]): PinchAction {
    return this.stop(touches);
  }

  private stop(touches: PinchPoint[]): PinchAction {
    if (!this.active) return NONE;
    if (touches.length >= 2) return NONE; // still pinching with another pair
    this.startSpread = 0;
    return { kind: "commit" };
  }
}

function spread(t: PinchPoint[]): number {
  return Math.hypot(t[0].x - t[1].x, t[0].y - t[1].y);
}

function midpoint(t: PinchPoint[]): PinchPoint {
  return { x: (t[0].x + t[1].x) / 2, y: (t[0].y + t[1].y) / 2 };
}
