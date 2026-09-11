import { describe, expect, it } from "vitest";
import {
  classifyExternalXml,
  contentFingerprint,
} from "../src/obsidian/sync-policy";

const XML = "<timeline><event>Qarqar</event></timeline>";

describe("contentFingerprint", () => {
  it("is stable for identical content and differs for changed content", () => {
    expect(contentFingerprint(XML)).toBe(contentFingerprint(XML));
    expect(contentFingerprint(XML)).not.toBe(
      contentFingerprint(XML.replace("Qarqar", "Qarqaz"))
    );
  });

  it("separates same-length edits", () => {
    expect(contentFingerprint("abcd")).not.toBe(contentFingerprint("abdc"));
  });
});

describe("classifyExternalXml", () => {
  const base = { lastWrittenMtime: 1000, lastFingerprint: contentFingerprint(XML) };

  it("says nothing while the mtime has not moved past the grace window", () => {
    expect(classifyExternalXml({ ...base, mtime: 1500 }).kind).toBe("unchanged");
  });

  it("treats a re-downloaded but identical file as a touch, not an edit", () => {
    // What iCloud / Remotely Save do: same bytes, new timestamp.
    const verdict = classifyExternalXml({
      ...base,
      mtime: 99999,
      fingerprint: contentFingerprint(XML),
    });
    expect(verdict.kind).toBe("touched");
  });

  it("reports a genuine edit from another device", () => {
    const verdict = classifyExternalXml({
      ...base,
      mtime: 99999,
      fingerprint: contentFingerprint(XML + "<event>New</event>"),
    });
    expect(verdict.kind).toBe("changed");
  });

  it("falls back to the timestamp when no fingerprint is known yet", () => {
    expect(
      classifyExternalXml({ mtime: 99999, lastWrittenMtime: 1000 }).kind
    ).toBe("changed");
  });

  it("stays quiet when there is no baseline at all", () => {
    expect(
      classifyExternalXml({ mtime: 99999, lastWrittenMtime: null }).kind
    ).toBe("unchanged");
  });
});
