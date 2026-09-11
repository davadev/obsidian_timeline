#!/usr/bin/env node
// Release guard. Run with no tag to validate a committed state (main / PRs),
// or with --tag <tag> to validate that the working tree matches the tag being
// published. Exits non-zero with every failure listed.
//
//   node scripts/check-release.mjs                  # committed state
//   node scripts/check-release.mjs --tag 0.10.0     # stable release
//   node scripts/check-release.mjs --tag 0.10.0-beta.1 --artifacts
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (f) => JSON.parse(await readFile(join(ROOT, f), "utf8"));

const args = process.argv.slice(2);
const tagIdx = args.indexOf("--tag");
const tag = tagIdx === -1 ? "" : (args[tagIdx + 1] ?? "");
const wantArtifacts = args.includes("--artifacts") || tagIdx !== -1;

const STABLE = /^\d+\.\d+\.\d+$/;
const PRERELEASE = /^\d+\.\d+\.\d+-(?:rc|beta|alpha)\.\d+$/;
const ARTIFACTS = ["main.js", "manifest.json", "styles.css"];
const REQUIRED_MANIFEST_KEYS = [
  "id",
  "name",
  "version",
  "minAppVersion",
  "description",
  "author",
  "isDesktopOnly",
];

const errors = [];
const ok = [];
const check = (cond, message, pass) => {
  if (cond) ok.push(pass ?? message);
  else errors.push(message);
};

const manifest = await readJson("manifest.json");
const pkg = await readJson("package.json");
const lock = await readJson("package-lock.json");
const versions = await readJson("versions.json");
const version = manifest.version;

if (tagIdx !== -1) {
  // A tag must equal manifest.version EXACTLY, suffix included. Never strip
  // "-beta.N" and compare the base -- that is what lets a default branch
  // advertise a version no release provides.
  check(tag !== "", "--tag given with no value");
  check(
    !/^v/.test(tag),
    `tag "${tag}" is v-prefixed; Obsidian matches the bare version, use "${tag.replace(/^v/, "")}"`,
    `tag "${tag}" is not v-prefixed`,
  );
  check(
    STABLE.test(tag) || PRERELEASE.test(tag),
    `tag "${tag}" is not X.Y.Z or X.Y.Z-(rc|beta|alpha).N`,
    `tag "${tag}" is well formed`,
  );
  check(
    version === tag,
    `manifest.version "${version}" != tag "${tag}"`,
    `manifest.version matches tag "${tag}"`,
  );
} else {
  // Validating a committed state: the default branch must always name a
  // published stable version.
  check(
    STABLE.test(version),
    `manifest.version "${version}" is not a plain X.Y.Z; the default branch must stay stable`,
    `manifest.version "${version}" is stable`,
  );
}

check(
  pkg.version === version,
  `package.json version "${pkg.version}" != manifest.version "${version}"`,
  "package.json version agrees with manifest",
);
check(
  lock.version === version,
  `package-lock.json version "${lock.version}" != manifest.version "${version}"`,
  "package-lock.json version agrees with manifest",
);
if (lock.packages?.[""]) {
  check(
    lock.packages[""].version === version,
    `package-lock.json packages[""] version "${lock.packages[""].version}" != "${version}"`,
    'package-lock.json packages[""] version agrees with manifest',
  );
}

for (const key of REQUIRED_MANIFEST_KEYS) {
  check(
    manifest[key] !== undefined && manifest[key] !== "",
    `manifest.json is missing "${key}"`,
    `manifest.json has "${key}"`,
  );
}
check(
  STABLE.test(String(manifest.minAppVersion ?? "")),
  `manifest.minAppVersion "${manifest.minAppVersion}" is not X.Y.Z`,
  `minAppVersion "${manifest.minAppVersion}" is well formed`,
);
check(
  versions[version] === manifest.minAppVersion,
  `versions.json["${version}"] is "${versions[version]}", expected minAppVersion "${manifest.minAppVersion}"`,
  `versions.json maps ${version} -> ${manifest.minAppVersion}`,
);

for (const file of ARTIFACTS) {
  let size = -1;
  try {
    size = (await stat(join(ROOT, file))).size;
  } catch {
    /* missing */
  }
  if (size <= 0 && !wantArtifacts) {
    ok.push(`skipped ${file} (not built; pass --artifacts to require it)`);
    continue;
  }
  check(
    size > 0,
    `release artifact "${file}" is missing or empty (run npm run build)`,
    `artifact ${file} present (${size} bytes)`,
  );
}

for (const line of ok) console.log(`  ok  ${line}`);
if (errors.length) {
  for (const line of errors) console.error(`FAIL  ${line}`);
  console.error(`\ncheck-release: ${errors.length} problem(s)`);
  process.exit(1);
}
console.log(`\ncheck-release: ${version}${tag ? ` (tag ${tag})` : ""} OK`);
