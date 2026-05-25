/**
 * Browser/Mobile-safe base64 helpers. Uses `btoa` / `atob` which are present
 * on both desktop Electron and Obsidian Mobile (iOS / Android WebView).
 * Never touches Node Buffer.
 */

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000; // avoid call-stack overflow on big files
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    bin += String.fromCharCode.apply(null, Array.from(slice));
  }
  return btoa(bin);
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const clean = b64.replace(/\s+/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** Pick the file extension that best matches the magic bytes of a base64 payload. */
export function guessImageExtension(b64: string): string {
  const head = b64.slice(0, 16);
  if (head.startsWith("iVBORw0KG")) return "png";
  if (head.startsWith("/9j/")) return "jpg";
  if (head.startsWith("R0lGOD")) return "gif";
  if (head.startsWith("UklGR")) return "webp";
  if (head.startsWith("PHN2Z")) return "svg"; // <svg in base64
  return "png";
}
