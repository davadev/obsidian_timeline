#!/usr/bin/env node
// Release guard. Run with no tag to validate a committed state (main / PRs),
// or with --tag <tag> to validate that the working tree matches the tag being
// published. Exits non-zero with every failure listed.
//
//   node scripts/check-release.mjs                  # committed state
//   node scripts/check-release.mjs --tag 0.10.0     # stable release
//   node scripts/check-release.mjs --tag 0.10.0-beta.1 --artifacts
//   node scripts/check-release.mjs --with-lint | --with-build | --strict
import { spawnSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MIN_AGE_DAYS,
  MIN_NPM_WITH_RELEASE_AGE,
  checkAllowScripts,
  checkDependabotCooldown,
  checkNpmrc,
  npmSupportsMinReleaseAge,
} from "./lib/supplyChainChecks.mjs";
import {
  attestStepProblem,
  lintScriptIsStrict,
  manifestFindings,
  nodeOnlyImports,
  usesCssPrefix,
} from "./lib/releaseChecks.mjs";

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

// Supply chain: a version younger than MIN_AGE_DAYS is never adopted, and no
// dependency runs install scripts. docs/releasing.md and the playbook explain why.
const readText = async (f) => readFile(join(ROOT, f), "utf8").catch(() => undefined);
const rc = checkNpmrc(await readText(".npmrc"));
check(rc.ok, `.npmrc: ${rc.problem}`, `.npmrc min-release-age is ${rc.days} days`);
const dep = checkDependabotCooldown(await readText(".github/dependabot.yml"));
check(
  dep.ok,
  `dependabot cooldown: ${dep.problems.join("; ")}`,
  `dependabot cooldown >= ${MIN_AGE_DAYS} days (npm + github-actions)`,
);
const npmV = spawnSync("npm", ["-v"], { encoding: "utf8" });
const npmVersion = npmV.status === 0 ? npmV.stdout.trim() : "";
check(
  npmSupportsMinReleaseAge(npmVersion),
  `npm ${npmVersion || "?"} is older than ${MIN_NPM_WITH_RELEASE_AGE}: .npmrc min-release-age would be a silent no-op`,
  `npm ${npmVersion} honours min-release-age`,
);
const scripts = checkAllowScripts(pkg.allowScripts);
check(scripts.ok, `install scripts: ${scripts.problem}`, "install scripts: nothing approved");
check(
  !pkg.dependencies || Object.keys(pkg.dependencies).length === 0,
  "package.json has runtime dependencies; the bundler inlines everything, keep them in devDependencies",
  "no runtime dependencies",
);
const tree = spawnSync("npm", ["ls", "--all"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
check(
  tree.status === 0,
  "`npm ls --all` reports problems (npm ci does not catch an inconsistent tree)",
  "dependency tree is internally consistent",
);

// Community-store submission rules (manifest id/name/description, mobile-safe
// imports, assets) live in scripts/lib/releaseChecks.mjs so they are tested.
const warnings = [];
for (const f of manifestFindings(manifest)) {
  if (f.level === "fail") errors.push(`${f.name}${f.detail ? `: ${f.detail}` : ""}`);
  else if (f.level === "warn") warnings.push(`${f.name}${f.detail ? `: ${f.detail}` : ""}`);
  else ok.push(f.name);
}

const sourceFiles = async (dir) => {
  const out = [];
  for (const e of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...(await sourceFiles(rel)));
    else if (rel.endsWith(".ts")) out.push(rel);
  }
  return out;
};
const sources = await sourceFiles("src");
const sourceText = (await Promise.all(sources.map((f) => readFile(join(ROOT, f), "utf8")))).join("\n");
const nodeOnly = [...new Set(nodeOnlyImports(sourceText))];
check(
  manifest.isDesktopOnly === true || nodeOnly.length === 0,
  `source imports Node-only modules (${nodeOnly.join(", ")}) but manifest.isDesktopOnly is not true; they crash on Obsidian mobile`,
  "no Node-only imports (works on mobile)",
);
check(
  !/\/(?:Users|home)\/[a-zA-Z][\w.-]*|[A-Za-z]:\\Users\\[a-zA-Z]/.test(sourceText),
  "source contains a hardcoded user path",
  "no hardcoded user paths",
);
for (const f of ["README.md", "LICENSE", "versions.json"]) {
  check((await stat(join(ROOT, f)).catch(() => null))?.size > 0, `${f} is missing or empty`, `${f} present`);
}
check(
  !usesCssPrefix(sourceText, "txs") || (await stat(join(ROOT, "styles.css")).catch(() => null))?.size > 0,
  "source uses txs- classes but styles.css is missing",
  "styles.css present where the source needs it",
);
check(lintScriptIsStrict(pkg.scripts?.lint), "`npm run lint` must pass --max-warnings 0", "lint fails on any warning");
const releaseYml = await readFile(join(ROOT, ".github/workflows/release.yml"), "utf8").catch(() => "");
const attest = attestStepProblem(releaseYml);
check(attest.ok, `release.yml: ${attest.problem}`, "release.yml signs main.js, manifest.json and styles.css");

for (const line of ok) console.log(`  ok  ${line}`);
// --with-lint runs the lint gates; --with-build also runs the build and the
// tests (what the release workflow does on a clean runner). The pre-tag hook
// uses --with-lint so a tag cannot be made past a red lint.
const withBuild = args.includes("--with-build");
if (args.includes("--with-lint") || withBuild) {
  for (const script of withBuild ? ["lint", "lint:css", "lint:deps", "build", "test:cov"] : ["lint", "lint:css", "lint:deps"]) {
    const r = spawnSync("npm", ["run", script, "--silent"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    check(r.status === 0, `npm run ${script} failed (exit ${r.status})\n${(r.stdout + r.stderr).split("\n").slice(-15).join("\n")}`, `npm run ${script} passes`);
  }
}
const strict = args.includes("--strict");
for (const line of warnings) {
  if (strict) errors.push(`${line} (warning, blocking under --strict)`);
  else console.log(`WARN  ${line}`);
}
if (errors.length) {
  for (const line of errors) console.error(`FAIL  ${line}`);
  console.error(`\ncheck-release: ${errors.length} problem(s)`);
  process.exit(1);
}
console.log(`\ncheck-release: ${version}${tag ? ` (tag ${tag})` : ""} OK`);
