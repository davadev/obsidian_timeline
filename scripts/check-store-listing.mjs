#!/usr/bin/env node
// Fails when the default branch's manifest.json advertises a version that has no
// published, non-prerelease GitHub release with main.js, manifest.json and
// styles.css (docs/releasing.md, "The one invariant"). Needs `gh` and GH_TOKEN.
// Usage:  node scripts/check-store-listing.mjs                    # push to the default branch: always check
//         node scripts/check-store-listing.mjs --base origin/main # PR: only when manifest.version differs from the base's
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { checkStoreListing } from "./lib/releaseChecks.mjs";

const REQUIRED = ["main.js", "manifest.json", "styles.css"];
const argv = process.argv.slice(2);
const base = argv.includes("--base") ? argv[argv.indexOf("--base") + 1] : null;
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const versions = JSON.parse(readFileSync("versions.json", "utf8"));

if (base) {
  const shown = spawnSync("git", ["show", `${base}:manifest.json`], { encoding: "utf8" });
  if (shown.status === 0 && JSON.parse(shown.stdout).version === manifest.version) {
    console.log(`store-listing: version unchanged (${manifest.version}); nothing to check`);
    process.exit(0);
  }
}

const gh = spawnSync("gh", ["release", "view", manifest.version, "--json", "isPrerelease,isDraft,assets"], { encoding: "utf8" });
const release = gh.status === 0 ? JSON.parse(gh.stdout) : null;
if (!release && !/release not found/i.test(gh.stderr)) {
  console.error(`store-listing: gh failed: ${gh.stderr.trim() || "no output"}`);
  process.exit(1);
}

let failed = 0;
for (const r of checkStoreListing({ version: manifest.version, release, versions, requiredAssets: REQUIRED })) {
  console.log(`${r.level === "pass" ? "ok  " : "FAIL"} ${r.name}${r.detail ? `: ${r.detail}` : ""}`);
  if (r.level === "fail") failed++;
}
process.exit(failed ? 1 : 0);
