/**
 * Per-device preferences. Stored through the App's device-local storage so
 * they do NOT travel with the vault — important on iOS where the device might
 * not have write access to the XML file (or the user simply wants only the
 * desktop to own writes).
 */
import { clearDevice, readDevice, writeDevice } from "./app-storage";

const KEY_SYNC = "device-sync";
/** Raw localStorage key used before 0.9.4; migrated on first read. */
const LEGACY_KEY_SYNC = "txs:device-sync";

export type DeviceSyncMode = "global" | "on" | "off";

export function getDeviceSyncMode(): DeviceSyncMode {
  const v = readDevice<string>(KEY_SYNC, LEGACY_KEY_SYNC);
  if (v === "on" || v === "off") return v;
  return "global";
}

export function setDeviceSyncMode(mode: DeviceSyncMode): void {
  if (mode === "global") clearDevice(KEY_SYNC, LEGACY_KEY_SYNC);
  else writeDevice(KEY_SYNC, mode);
}

/** Combine global setting and per-device override. */
export function effectiveAutoSync(globalAutoSync: boolean): boolean {
  const m = getDeviceSyncMode();
  if (m === "on") return true;
  if (m === "off") return false;
  return globalAutoSync;
}
