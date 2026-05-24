/**
 * Per-device preferences. Stored in localStorage so they do NOT travel with
 * the vault — important on iOS where the device might not have write access
 * to the XML file (or the user simply wants only the desktop to own writes).
 */

const KEY_SYNC = "txs:device-sync";

export type DeviceSyncMode = "global" | "on" | "off";

export function getDeviceSyncMode(): DeviceSyncMode {
  try {
    const v = (typeof localStorage !== "undefined" && localStorage.getItem(KEY_SYNC)) || "";
    if (v === "on" || v === "off") return v;
    return "global";
  } catch {
    return "global";
  }
}

export function setDeviceSyncMode(mode: DeviceSyncMode): void {
  try {
    if (mode === "global") localStorage.removeItem(KEY_SYNC);
    else localStorage.setItem(KEY_SYNC, mode);
  } catch {
    /* ignore — no-op when localStorage unavailable */
  }
}

/** Combine global setting and per-device override. */
export function effectiveAutoSync(globalAutoSync: boolean): boolean {
  const m = getDeviceSyncMode();
  if (m === "on") return true;
  if (m === "off") return false;
  return globalAutoSync;
}
