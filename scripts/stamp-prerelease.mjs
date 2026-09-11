#!/usr/bin/env node
// Rewrites version metadata in the WORKING TREE ONLY so a prerelease tag can
// publish assets carrying X.Y.Z-beta.N while the committed manifest on the
// default branch keeps naming the current stable version. Nothing here is
// meant to be committed -- CI runs it for suffixed tags before the build.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const die = (m) => {
  console.error(`stamp-prerelease: ${m}`);
  process.exit(1);
};
const readJson = async (f) => JSON.parse(await readFile(join(ROOT, f), "utf8"));
const writeJson = (f, o) =>
  writeFile(join(ROOT, f), `${JSON.stringify(o, null, "\t")}\n`, "utf8");
const cmp = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

const tag = String(process.argv[2] || "").replace(/^v/, "");
const m = /^(\d+\.\d+\.\d+)-((?:rc|beta|alpha)\.\d+)$/.exec(tag);
if (!m) die(`not a prerelease tag: "${process.argv[2]}" (want 0.10.0-beta.1)`);
const base = m[1];

const manifest = await readJson("manifest.json");
const pkg = await readJson("package.json");
const lock = await readJson("package-lock.json");
const versions = await readJson("versions.json");
const stable = manifest.version;

if (/-/.test(stable)) die(`manifest is already a prerelease ("${stable}")`);
if (cmp(base, stable) <= 0)
  die(`${tag}: base ${base} is not newer than current stable ${stable}`);

manifest.version = tag;
pkg.version = tag;
lock.version = tag;
if (lock.packages?.[""]) lock.packages[""].version = tag;
versions[tag] = manifest.minAppVersion; // keeps the release guard happy

await writeJson("manifest.json", manifest);
await writeJson("package.json", pkg);
await writeJson("package-lock.json", lock);
await writeJson("versions.json", versions);
console.log(`stamped ${stable} -> ${tag} (working tree only)`);
