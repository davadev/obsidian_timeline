import { describe, expect, it } from "vitest";
import {
  attestStepProblem,
  checkStoreListing,
  classifyReleaseCommand,
  isPrerelease,
  isReleaseTagCommand,
  lintScriptIsStrict,
  manifestFindings,
  nodeOnlyImports,
  stripYamlComments,
  usesCssPrefix,
  versionFindings,
} from "../scripts/lib/releaseChecks.mjs";

type Finding = { level: string; name: string; detail: string };
const levels = (fs: Finding[]) => fs.filter((f) => f.level !== "pass").map((f) => `${f.level}:${f.name}`);

const good = { id: "timeline-xml-sync", name: "Timeline XML Sync", version: "1.0.0", minAppVersion: "1.13.0", description: "Two-way sync between XML and notes.", author: "me", isDesktopOnly: false };

describe("manifestFindings", () => {
  it("passes a good manifest", () => expect(levels(manifestFindings(good))).toEqual([]));

  it("flags missing or empty required fields", () => {
    expect(levels(manifestFindings({ ...good, author: "", version: 3 }))).toContain("fail:manifest.json required string fields");
  });

  it("enforces the official id and name rules", () => {
    expect(levels(manifestFindings({ ...good, id: "My_Plugin" }))).toContain("fail:manifest.id follows the official rule");
    expect(levels(manifestFindings({ ...good, id: "cool-plugin" }))).toContain("fail:manifest.id follows the official rule");
    expect(levels(manifestFindings({ ...good, id: "obsidian-x" }))).toContain("fail:manifest.id does not contain obsidian");
    expect(levels(manifestFindings({ ...good, name: "Obsidian Timeline" }))).toContain("fail:manifest.name does not contain Obsidian");
    expect(levels(manifestFindings({ ...good, name: "Timeline Plugin" }))).toContain("fail:manifest.name does not contain the word 'Plugin'");
    expect(levels(manifestFindings({ ...good, name: "Timeline!" }))).toContain("fail:manifest.name uses Basic Latin only");
    expect(levels(manifestFindings({ ...good, name: "Obsi-dian Time" }))).toContain("fail:manifest.name avoids variations of Obsidian");
  });

  it("enforces the description rules", () => {
    const d = (description: string) => levels(manifestFindings({ ...good, description }));
    expect(d("x".repeat(251))).toContain("fail:manifest.description length");
    expect(d("Short.")).toContain("warn:manifest.description is descriptive");
    expect(d("This is a plugin that does things.")).toContain("fail:manifest.description avoids boilerplate");
    expect(d("A sync tool with a smiley 😀 in it ok.")).toContain("fail:manifest.description has no emoji");
    expect(d("No full stop at the end of this one")).toContain("fail:manifest.description ends with a period");
    expect(d("lowercase start but long enough here.")).toContain("warn:manifest.description starts with a capital");
  });

  it("checks isDesktopOnly, authorUrl and fundingUrl", () => {
    expect(levels(manifestFindings({ ...good, isDesktopOnly: "no" }))).toContain("fail:manifest.isDesktopOnly is a boolean");
    expect(levels(manifestFindings({ ...good, authorUrl: "https://example.com" }))).toEqual([]);
    expect(levels(manifestFindings({ ...good, authorUrl: "ftp://x" }))).toContain("warn:manifest.authorUrl is an http(s) URL");
    expect(levels(manifestFindings({ ...good, fundingUrl: "https://ko-fi.com/me" }))).toEqual([]);
    expect(levels(manifestFindings({ ...good, fundingUrl: { a: "https://github.com/sponsors/me" } }))).toEqual([]);
    expect(levels(manifestFindings({ ...good, fundingUrl: "https://evil.example/pay" }))).toContain("fail:manifest.fundingUrl points to a financial-support service");
    expect(levels(manifestFindings({ ...good, fundingUrl: "not a url" }))).toContain("fail:manifest.fundingUrl points to a financial-support service");
    expect(levels(manifestFindings({ ...good, fundingUrl: 5 }))).toEqual([]);
  });

  it("does not throw on an empty manifest", () => {
    expect(() => manifestFindings({})).not.toThrow();
  });
});

describe("versionFindings", () => {
  const pkg = { version: "1.0.0" };
  const lock = { version: "1.0.0", packages: { "": { version: "1.0.0" } } };
  const versions = { "1.0.0": "1.13.0" };
  const run = (over: Record<string, unknown> = {}) => levels(versionFindings({ manifest: good, pkg, lock, versions, tag: null, ...over } as never));

  it("passes when everything agrees on a stable version", () => expect(run()).toEqual([]));
  it("catches disagreement between manifest, package and lockfile", () => {
    expect(run({ pkg: { version: "1.0.1" } })).toContain("fail:manifest.version matches package.json");
    expect(run({ lock: { version: "0.9.0", packages: { "": { version: "0.9.0" } } } })).toContain("fail:package-lock.json version matches package.json");
    expect(run({ lock: { version: "1.0.0" } })).toContain("fail:package-lock.json version matches package.json");
  });
  it("requires versions.json to list the version, with the same minAppVersion", () => {
    expect(run({ versions: {} })).toContain("fail:manifest.version listed in versions.json");
    expect(run({ versions: { "1.0.0": "1.0.0" } })).toContain("warn:versions.json minAppVersion agrees with manifest");
  });
  it("requires the tag to equal the manifest version exactly", () => {
    expect(run({ tag: "1.0.0" })).toEqual([]);
    expect(run({ tag: "1.0.1" })).toContain("fail:manifest.version matches release tag");
    const beta = versionFindings({ manifest: good, pkg, lock, versions, tag: "1.1.0-beta.1" } as never).find((f: Finding) => f.level === "fail")!;
    expect(beta.detail).toContain("stamp-prerelease");
  });
  it("keeps prereleases off the default branch", () => {
    expect(levels(versionFindings({ manifest: { ...good, version: "1.1.0-beta.1" }, pkg: undefined, lock: undefined, versions: undefined, tag: null } as never))).toContain("fail:committed manifest.version is a stable version");
  });
  it("tolerates missing inputs", () => {
    expect(versionFindings({} as never)).toEqual([]);
  });
});

describe("small predicates", () => {
  it("detects node-only imports", () => {
    expect(nodeOnlyImports(`import fs from "fs"; const p = require('node:path'); import x from "yaml";`)).toEqual(["fs", "node:path"]);
    expect(nodeOnlyImports("nothing")).toEqual([]);
  });
  it("detects the CSS prefix", () => {
    expect(usesCssPrefix('cls: "txs-chart"', "txs")).toBe(true);
    expect(usesCssPrefix('cls: "other"', "txs")).toBe(false);
  });
  it("detects prereleases and strict lint scripts", () => {
    expect(isPrerelease("1.0.0-beta.1")).toBe(true);
    expect(isPrerelease("1.0.0")).toBe(false);
    expect(isPrerelease(undefined)).toBe(false);
    expect(lintScriptIsStrict("eslint . --max-warnings 0")).toBe(true);
    expect(lintScriptIsStrict("eslint . --max-warnings=0")).toBe(true);
    expect(lintScriptIsStrict("eslint .")).toBe(false);
    expect(lintScriptIsStrict(undefined)).toBe(false);
  });
  it("strips YAML comments", () => {
    expect(stripYamlComments("a: 1 # note\n# whole\nb: 2")).toBe("a: 1\n\nb: 2");
  });
});

describe("attestStepProblem", () => {
  const step = (uses = "actions/attest@abc # v4") => `steps:\n  - name: Attest\n    uses: ${uses}\n    with:\n      subject-path: |\n        main.js\n        manifest.json\n        styles.css\n  - name: Publish\n    run: gh release create`;
  it("accepts a real step listing every asset, either action", () => {
    expect(attestStepProblem(step()).ok).toBe(true);
    expect(attestStepProblem(step("actions/attest-build-provenance@abc")).ok).toBe(true);
  });
  it("rejects a missing step, ignoring prose that merely mentions it", () => {
    expect(attestStepProblem("steps:\n  - name: x\n    run: echo\n  # we use actions/attest@v4 here\n").problem).toContain("no actions/attest step");
  });
  it("rejects a step that omits an asset", () => {
    expect(attestStepProblem(step().replace("styles.css", "")).problem).toContain("styles.css");
  });
});

describe("release command classification", () => {
  it("blocks hand-made releases and bulk tag pushes", () => {
    expect(classifyReleaseCommand("gh release create 1.0.0 main.js")).toBe("block-release-cmd");
    expect(classifyReleaseCommand("gh release upload 1.0.0 x")).toBe("block-release-cmd");
    expect(classifyReleaseCommand("git push --tags")).toBe("block-push-tags");
    expect(classifyReleaseCommand("git push origin main --follow-tags")).toBe("block-push-tags");
  });
  it("asks for the guard before a SemVer tag is made or pushed", () => {
    for (const c of ["git tag 1.2.3", "git tag -a 1.2.3-beta.1 -m x", "git push origin 1.2.3", "git push origin HEAD:refs/tags/1.2.3"]) {
      expect(classifyReleaseCommand(c), c).toBe("needs-check");
      expect(isReleaseTagCommand(c)).toBe(true);
    }
  });
  it("allows everything else, including deleting a tag", () => {
    for (const c of ["git tag -d 1.2.3", "git push origin main", "git status", "git tag v-notes", undefined]) {
      expect(classifyReleaseCommand(c as string), String(c)).toBe("allow");
    }
    expect(isReleaseTagCommand("ls")).toBe(false);
  });
});

describe("checkStoreListing", () => {
  const rel = (over = {}) => ({ isDraft: false, isPrerelease: false, assets: [{ name: "main.js" }, { name: "manifest.json" }, { name: "styles.css" }], ...over });
  const versions = { "1.0.0": "1.13.0" };
  const run = (over: Record<string, unknown> = {}) => levels(checkStoreListing({ version: "1.0.0", release: rel(), versions, ...over } as never));

  it("passes a published stable release with its assets", () => expect(run()).toEqual([]));
  it("fails a prerelease version, a missing release, a draft, a prerelease flag, missing assets or an unlisted version", () => {
    expect(run({ version: "1.0.0-beta.1" })).toEqual(["fail:advertised version is stable"]);
    expect(run({ release: null })).toEqual(["fail:release 1.0.0 exists"]);
    expect(run({ release: rel({ isDraft: true }) })).toContain("fail:release 1.0.0 is published");
    expect(run({ release: rel({ isPrerelease: true }) })).toContain("fail:release 1.0.0 is not a prerelease");
    expect(run({ release: rel({ assets: [{ name: "main.js" }] }) })).toContain("fail:release 1.0.0 has its assets");
    expect(run({ release: rel({ assets: undefined }) })).toContain("fail:release 1.0.0 has its assets");
    expect(run({ versions: {} })).toContain("fail:versions.json lists 1.0.0");
    expect(run({ versions: undefined })).toContain("fail:versions.json lists 1.0.0");
  });
});
