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
