import type { App } from "obsidian";

/**
 * Per-device storage.
 *
 * Values written here never travel with the vault — that is the point: which
 * device is allowed to write the XML, and which categories a given render
 * block has hidden, are device-local decisions.
 *
 * Obsidian's guidelines ask plugins to go through `App#saveLocalStorage` /
 * `App#loadLocalStorage` rather than touching `localStorage` directly, so the
 * data is namespaced per vault. Earlier versions of this plugin used raw
 * `localStorage` keys; `read()` migrates those on first access.
 */

let app: App | null = null;

/** In-memory stand-in for contexts with no App (unit tests, pure renders). */
const fallback = new Map<string, unknown>();

/** Called once from the plugin's onload. */
export function initDeviceStore(a: App): void {
  app = a;
}

/**
 * Read a device-local value. `legacyKey`, when given, names the raw
 * localStorage key used before 0.9.4; its value is migrated on first read and
 * the legacy entry removed.
 */
export function readDevice<T>(key: string, legacyKey?: string): T | null {
  if (!app) return (fallback.get(key) as T | undefined) ?? null;

  const stored: unknown = app.loadLocalStorage(key);
  if (stored != null) return stored as T;

  if (legacyKey) {
    const legacy = readLegacy(legacyKey);
    if (legacy != null) {
      app.saveLocalStorage(key, legacy);
      return legacy as T;
    }
  }
  return null;
}

export function writeDevice(key: string, value: unknown): void {
  if (!app) {
    fallback.set(key, value);
    return;
  }
  app.saveLocalStorage(key, value);
}

export function clearDevice(key: string, legacyKey?: string): void {
  if (!app) {
    fallback.delete(key);
    return;
  }
  app.saveLocalStorage(key, null);
  if (legacyKey) removeLegacy(legacyKey);
}

/**
 * `window.localStorage` (rather than the bare global) on purpose: this is the
 * one place allowed to look at the pre-0.9.4 storage layout.
 */
function readLegacy(legacyKey: string): unknown {
  try {
    const raw = window.localStorage.getItem(legacyKey);
    if (raw == null) return null;
    removeLegacy(legacyKey);
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw; // plain string values (e.g. the device sync mode)
    }
  } catch {
    return null;
  }
}

function removeLegacy(legacyKey: string): void {
  try {
    window.localStorage.removeItem(legacyKey);
  } catch {
    /* ignore — storage unavailable */
  }
}
