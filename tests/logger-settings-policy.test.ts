import { afterEach, describe, expect, it, vi } from "vitest";
import { logDebug, logDump, logError, logWarn, setLogLevel } from "../src/logger";
import { DEFAULT_SETTINGS, resolveBackupFolder, resolveLogFolder } from "../src/settings";
import { classifyExternalXml, contentFingerprint, shouldAbortXmlWrite, shouldSkipNoteOverwrite } from "../src/obsidian/sync-policy";

afterEach(() => {
  vi.restoreAllMocks();
  setLogLevel("error");
});

describe("logger", () => {
  const spies = () => ({
    debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  });

  it("logs only errors by default", () => {
    const s = spies();
    logDebug("d");
    logWarn("w");
    logError("e");
    expect(s.debug).not.toHaveBeenCalled();
    expect(s.warn).not.toHaveBeenCalled();
    expect(s.error).toHaveBeenCalledWith("[Timeline XML Sync]", "e");
  });

  it("widens with the level", () => {
    const s = spies();
    setLogLevel("warn");
    logDebug("d");
    logWarn("w");
    expect(s.debug).not.toHaveBeenCalled();
    expect(s.warn).toHaveBeenCalledWith("[Timeline XML Sync]", "w");
    setLogLevel("debug");
    logDebug("d");
    expect(s.debug).toHaveBeenCalledWith("[Timeline XML Sync]", "d");
  });

  it("logDump always prints, at debug severity", () => {
    const s = spies();
    logDump("a", 1);
    expect(s.debug).toHaveBeenCalledWith("[Timeline XML Sync]", "a", 1);
  });
});

describe("settings folders", () => {
  it("default to folders beside the event notes, and honour an explicit override", () => {
    const s = { ...DEFAULT_SETTINGS, eventNotesDir: "Ev" };
    expect(resolveBackupFolder(s)).toBe("Ev/_backups");
    expect(resolveLogFolder(s)).toBe("Ev/_logs");
    expect(resolveBackupFolder({ ...s, backupFolder: "  Mine " })).toBe("Mine");
    expect(resolveLogFolder({ ...s, logFolder: " Logs  " })).toBe("Logs");
    expect(resolveBackupFolder({ ...s, backupFolder: "   " })).toBe("Ev/_backups");
    expect(resolveBackupFolder({ ...s, backupFolder: undefined as unknown as string })).toBe("Ev/_backups");
  });
});

describe("sync policy", () => {
  it("skips overwriting notes edited after the last XML write, or of unknown provenance", () => {
    expect(shouldSkipNoteOverwrite(undefined, 5)).toBe(false);
    expect(shouldSkipNoteOverwrite(10, undefined)).toBe(true);
    expect(shouldSkipNoteOverwrite(10_000, 5_000)).toBe(true);
    expect(shouldSkipNoteOverwrite(6_000, 5_000)).toBe(false);
    expect(shouldSkipNoteOverwrite(5_100, 5_000, 0)).toBe(true);
  });

  it("aborts an XML write only when someone else moved the mtime", () => {
    expect(shouldAbortXmlWrite(null, 5, 5)).toBe(false);
    expect(shouldAbortXmlWrite(5, null, 5)).toBe(false);
    expect(shouldAbortXmlWrite(1000, 1500, null)).toBe(false);
    expect(shouldAbortXmlWrite(1000, 5000, 5000)).toBe(false);
    expect(shouldAbortXmlWrite(1000, 5000, 4000)).toBe(true);
  });

  it("fingerprints content stably and distinguishes edits", () => {
    expect(contentFingerprint("abc")).toBe(contentFingerprint("abc"));
    expect(contentFingerprint("abc")).not.toBe(contentFingerprint("abd"));
    expect(contentFingerprint("")).toMatch(/^0-/);
  });

  it("classifies an XML whose mtime moved", () => {
    expect(classifyExternalXml({ mtime: null, lastWrittenMtime: 1 })).toEqual({ kind: "unchanged" });
    expect(classifyExternalXml({ mtime: 1, lastWrittenMtime: null })).toEqual({ kind: "unchanged" });
    expect(classifyExternalXml({ mtime: 2000, lastWrittenMtime: 1000 })).toEqual({ kind: "unchanged" });
    expect(classifyExternalXml({ mtime: 9000, lastWrittenMtime: 1000 })).toEqual({ kind: "changed" });
    expect(classifyExternalXml({ mtime: 9000, lastWrittenMtime: 1000, fingerprint: "a" })).toEqual({ kind: "changed" });
    expect(classifyExternalXml({ mtime: 9000, lastWrittenMtime: 1000, lastFingerprint: "a" })).toEqual({ kind: "changed" });
    expect(classifyExternalXml({ mtime: 9000, lastWrittenMtime: 1000, fingerprint: "a", lastFingerprint: "a" })).toEqual({ kind: "touched" });
    expect(classifyExternalXml({ mtime: 9000, lastWrittenMtime: 1000, fingerprint: "a", lastFingerprint: "b" })).toEqual({ kind: "changed" });
    expect(classifyExternalXml({ mtime: 3000, lastWrittenMtime: 1000, graceMs: 100 })).toEqual({ kind: "changed" });
  });
});
