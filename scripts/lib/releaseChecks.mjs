// Pure predicates behind scripts/check-release.mjs: manifest rules, version
// agreement, node-only imports vs isDesktopOnly, the release.yml attest-step
// guard, the release-tag command matcher and the store-listing invariant. No
// I/O, so tests/release-checks.test.ts can pin every branch. Findings are
// { level: "pass"|"fail"|"warn", name, detail }.
//
// Why each exists:
//   - tag != manifest.version: a default branch advertising 0.7.0 while only
//     0.7.0-beta.1 existed pointed every user's update check at a release that
//     did not exist.
//   - the attest guard strips comments: a plain substring search matched prose
//     about the step and stayed green after the real step was deleted.
//   - node-only imports: `fs`/`path` crash on Obsidian mobile unless the
//     manifest says isDesktopOnly.

/** Hosts accepted for manifest.fundingUrl. Obsidian only says fundingUrl is for financial-support services (Buy Me A Coffee, GitHub Sponsors); this allow-list is OUR heuristic, extend it for a legitimate service. */
export const FUNDING_HOSTS = ["github.com", "ko-fi.com", "buymeacoffee.com", "patreon.com", "opencollective.com", "liberapay.com", "paypal.me", "paypal.com", "stripe.com"];

/** Node/Electron modules that do not exist on Obsidian mobile. */
export const NODE_ONLY_IMPORTS = ["fs", "node:fs", "path", "node:path", "child_process", "node:child_process", "os", "node:os", "electron"];

const f = (level, name, detail = "") => ({ level, name, detail });

/** Every `from "x"` / `require("x")` specifier in a source text that is a node-only module. */
export function nodeOnlyImports(text) {
  const out = [];
  for (const m of text.matchAll(/(?:from|require\s*\()\s*['"]([^'"]+)['"]/g)) if (NODE_ONLY_IMPORTS.includes(m[1])) out.push(m[1]);
  return out;
}

/** Does `text` use a CSS class that starts with `prefix-`? (styles.css is required iff the source does.) */
export function usesCssPrefix(text, prefix) {
  return new RegExp(`\\b${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[a-z][a-z0-9-]*`).test(text);
}

/** `1.2.3-beta.1` -> true. */
export const isPrerelease = (v) => /-/.test(String(v ?? ""));

/** Rules for manifest.json. Returns findings; a missing/mistyped field never throws. */
export function manifestFindings(m) {
  const out = [];
  const req = ["id", "name", "version", "minAppVersion", "description", "author"];
  const missing = req.filter((k) => typeof m[k] !== "string" || m[k].length === 0);
  out.push(missing.length ? f("fail", "manifest.json required string fields", `missing/empty: ${missing.join(", ")}`) : f("pass", "manifest.json required string fields", req.join(", ")));

  const id = typeof m.id === "string" ? m.id : "";
  // Official Manifest rule: only lowercase letters and hyphens, cannot end with "plugin", cannot contain "obsidian".
  out.push(/^[a-z-]+$/.test(id) && !/plugin$/.test(id) ? f("pass", "manifest.id follows the official rule", id) : f("fail", "manifest.id follows the official rule", `id="${id}": only lowercase letters and hyphens, and it cannot end with "plugin"`));
  out.push(/obsidian/i.test(id) ? f("fail", "manifest.id does not contain obsidian", id) : f("pass", "manifest.id does not contain obsidian", id));
  const name = typeof m.name === "string" ? m.name : "";
  out.push(/obsidian/i.test(name) ? f("fail", "manifest.name does not contain Obsidian", name) : f("pass", "manifest.name does not contain Obsidian", name));
  out.push(/\bplugin\b/i.test(name) ? f("fail", "manifest.name does not contain the word 'Plugin'", name) : f("pass", "manifest.name does not contain the word 'Plugin'", name));
  // Official Manifest rule: Basic Latin only; no punctuation except hyphen, plus and parentheses; no emoji.
  out.push(/^[A-Za-z0-9 +()-]+$/.test(name) ? f("pass", "manifest.name uses Basic Latin only", name) : f("fail", "manifest.name uses Basic Latin only", `name="${name}": letters, digits, spaces and - + ( ) only`));
  out.push(/obsi-|-sidian/i.test(name) ? f("fail", "manifest.name avoids variations of Obsidian", name) : f("pass", "manifest.name avoids variations of Obsidian", name));

  if (typeof m.description === "string") {
    const d = m.description;
    out.push(d.length > 250 ? f("fail", "manifest.description length", `${d.length} chars, Obsidian allows 250`) : f("pass", "manifest.description length", `${d.length} chars`));
    out.push(d.length < 30 ? f("warn", "manifest.description is descriptive", `${d.length} chars, aim for 30+`) : f("pass", "manifest.description is descriptive"));
    out.push(/^this is a plugin\b/i.test(d) ? f("fail", "manifest.description avoids boilerplate", 'must not start with "This is a plugin"') : f("pass", "manifest.description avoids boilerplate"));
    out.push(/\p{Extended_Pictographic}/u.test(d) ? f("fail", "manifest.description has no emoji", d) : f("pass", "manifest.description has no emoji"));
    out.push(/\.$/.test(d) ? f("pass", "manifest.description ends with a period") : f("fail", "manifest.description ends with a period", d));
    out.push(/^[A-Z0-9]/.test(d) ? f("pass", "manifest.description starts with a capital") : f("warn", "manifest.description starts with a capital", d));
  }

  out.push(typeof m.isDesktopOnly === "boolean" ? f("pass", "manifest.isDesktopOnly is a boolean", String(m.isDesktopOnly)) : f("fail", "manifest.isDesktopOnly is a boolean", `got ${typeof m.isDesktopOnly}`));

  if (m.authorUrl != null) out.push(typeof m.authorUrl === "string" && /^https?:\/\//.test(m.authorUrl) ? f("pass", "manifest.authorUrl is an http(s) URL", m.authorUrl) : f("warn", "manifest.authorUrl is an http(s) URL", `got "${m.authorUrl}"`));
  if (m.fundingUrl != null) {
    const urls = typeof m.fundingUrl === "string" ? [m.fundingUrl] : typeof m.fundingUrl === "object" ? Object.values(m.fundingUrl) : [];
    const bad = urls.filter((u) => {
      try {
        const host = new URL(u).hostname.replace(/^www\./, "");
        return !FUNDING_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
      } catch {
        return true;
      }
    });
    out.push(bad.length ? f("fail", "manifest.fundingUrl points to a financial-support service", `unrecognised: ${bad.join(", ")}`) : f("pass", "manifest.fundingUrl points to a financial-support service"));
  }
  return out;
}

/**
 * Version agreement across manifest / package.json / lockfile / versions.json, and against the tag.
 * `tag` is the release tag without a leading `v`, or null (a committed-state run: main, a PR, a local pre-flight).
 * The tag must equal manifest.version EXACTLY, prereleases included; with no tag the committed manifest must be stable.
 */
export function versionFindings({ manifest, pkg, lock, versions, tag }) {
  const out = [];
  if (manifest && pkg) out.push(manifest.version === pkg.version ? f("pass", `manifest.version (${manifest.version}) matches package.json`) : f("fail", "manifest.version matches package.json", `manifest=${manifest.version}, package=${pkg.version}`));
  if (pkg && lock) {
    const bad = [];
    if (lock.version !== pkg.version) bad.push(`package-lock.version=${lock.version}`);
    if (lock.packages?.[""]?.version !== pkg.version) bad.push(`package-lock.packages[""].version=${lock.packages?.[""]?.version}`);
    out.push(bad.length ? f("fail", "package-lock.json version matches package.json", `package.json=${pkg.version}; ${bad.join(", ")} (run npm install --package-lock-only)`) : f("pass", `package-lock.json version matches package.json (${pkg.version})`));
  }
  if (manifest && versions) {
    if (!Object.prototype.hasOwnProperty.call(versions, manifest.version)) out.push(f("fail", "manifest.version listed in versions.json", `add "${manifest.version}": "${manifest.minAppVersion || "1.5.0"}"`));
    else if (versions[manifest.version] !== manifest.minAppVersion) out.push(f("warn", "versions.json minAppVersion agrees with manifest", `versions.json says ${versions[manifest.version]}, manifest says ${manifest.minAppVersion}`));
    else out.push(f("pass", `manifest.version (${manifest.version}) listed in versions.json`));
  }
  if (manifest) {
    if (tag) {
      if (manifest.version === tag) out.push(f("pass", `manifest.version (${manifest.version}) matches release tag`));
      else {
        const unstamped = /-(?:rc|beta|alpha)\.\d+$/.test(tag) && !isPrerelease(manifest.version);
        out.push(f("fail", "manifest.version matches release tag", `manifest=${manifest.version}, tag=${tag}` + (unstamped ? `; run \`node scripts/stamp-prerelease.mjs ${tag}\` first (CI does this)` : "")));
      }
    } else if (isPrerelease(manifest.version)) {
      out.push(f("fail", "committed manifest.version is a stable version", `"${manifest.version}" carries a prerelease suffix; the default branch must advertise the current stable release (betas are stamped in CI only)`));
    } else out.push(f("pass", `committed manifest.version (${manifest.version}) is a stable version`));
  }
  return out;
}

/** `eslint ... --max-warnings=0` (or `--max-warnings 0`): a warning must fail the script, not scroll past. */
export const lintScriptIsStrict = (script) => /--max-warnings(?:=|\s+)0\b/.test(String(script ?? ""));

/** Strip YAML comments (`#` at line start or after whitespace). */
export const stripYamlComments = (text) => text.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "")).join("\n");

/**
 * Does release.yml carry a real actions/attest step whose own block lists every subject? Comments are stripped first
 * (see GUARDS). Both actions/attest and the wrapper actions/attest-build-provenance are accepted.
 * Returns { ok, problem }.
 */
export function attestStepProblem(workflowText, subjects = ["main.js", "manifest.json", "styles.css"]) {
  const code = stripYamlComments(workflowText);
  const starts = [...code.matchAll(/^\s*-\s+(?:name|uses):/gm)].map((m) => m.index);
  const steps = starts.map((from, i) => code.slice(from, i + 1 < starts.length ? starts[i + 1] : code.length));
  const step = steps.find((b) => /^\s*uses:\s*actions\/attest(-build-provenance)?@/m.test(b));
  if (!step) return { ok: false, problem: "no actions/attest step: release assets are not signed" };
  const missing = subjects.filter((s) => !step.includes(s));
  return missing.length ? { ok: false, problem: `attest step does not list subject(s): ${missing.join(", ")}` } : { ok: true, problem: null };
}

const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;

/**
 * Classify a shell command for the PreToolUse hook:
 *   "block-release-cmd"  gh release create|upload|edit|delete (release.yml publishes; never by hand)
 *   "block-push-tags"    git push --tags / --follow-tags (could publish a tag from an unreviewed commit; push ONE tag by name)
 *   "needs-check"        creates or pushes a SemVer tag (git tag [-a -m msg] X.Y.Z, git push origin X.Y.Z, HEAD:refs/tags/X.Y.Z)
 *   "allow"              anything else (including git tag -d)
 * A hook matches command TEXT only; it is a seatbelt, the release workflow is the real gate.
 */
export function classifyReleaseCommand(command) {
  const c = String(command ?? "");
  if (/\bgh\s+release\s+(?:create|upload|edit|delete)\b/.test(c)) return "block-release-cmd";
  if (/\bgit\s+push\b[^\n;&|]*--(?:follow-)?tags\b/.test(c)) return "block-push-tags";
  const creates = new RegExp(String.raw`\bgit\s+tag\b(?![^\n;&|]*\s-[a-zA-Z]*d\b)[^\n;&|]*\s${SEMVER}(?=\s|$|["';&|])`).test(c);
  const pushes = new RegExp(String.raw`\bgit\s+push\b[^\n;&|]*[\s:](?:refs/tags/)?${SEMVER}(?=\s|$|["';&|])`).test(c);
  return creates || pushes ? "needs-check" : "allow";
}

/** Does a shell command create or push a SemVer release tag? */
export const isReleaseTagCommand = (command) => classifyReleaseCommand(command) === "needs-check";

/**
 * The store-listing invariant (RELEASE-CYCLE section 1): the version the default branch advertises must have a
 * published, non-prerelease GitHub release carrying every asset, and be listed in versions.json.
 * `release` is the parsed `gh release view <v> --json isPrerelease,isDraft,assets` object, or null when it does not exist.
 */
export function checkStoreListing({ version, release, versions, requiredAssets = ["main.js", "manifest.json", "styles.css"] }) {
  const out = [];
  if (/-/.test(version)) return [f("fail", "advertised version is stable", `"${version}" has a prerelease suffix`)];
  if (!release) return [f("fail", `release ${version} exists`, `no GitHub release is tagged ${version}; publish it before the default branch advertises it`)];
  out.push(release.isDraft ? f("fail", `release ${version} is published`, "it is still a draft") : f("pass", `release ${version} is published`));
  out.push(release.isPrerelease ? f("fail", `release ${version} is not a prerelease`, "flagged prerelease") : f("pass", `release ${version} is not a prerelease`));
  const names = (release.assets ?? []).map((a) => a.name);
  const missing = requiredAssets.filter((n) => !names.includes(n));
  out.push(missing.length ? f("fail", `release ${version} has its assets`, `missing: ${missing.join(", ")}`) : f("pass", `release ${version} has its assets`));
  out.push(versions && Object.prototype.hasOwnProperty.call(versions, version) ? f("pass", `versions.json lists ${version}`) : f("fail", `versions.json lists ${version}`));
  return out;
}
