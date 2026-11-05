// Reproduces the Obsidian community-plugin auto-review's TYPE-AWARE view: it
// hides the `obsidian` (and @codemirror) type declarations in node_modules,
// lints, and puts them back. Exit 1 on any ERROR in that view.
//
// The review reports thousands of @typescript-eslint/no-unsafe-* WARNINGS the
// local lint never shows, because there `obsidian` types do not resolve and
// every `App | null` becomes `any`. Those warnings are the scanner's blindness,
// not defects. An ERROR in the blind view can still fail the review, so CI runs
// this and fails on errors only. It is NOT part of check-release: it renames
// node_modules directories while it runs, and restores them on exit, crash or
// Ctrl-C (if one is ever left hidden: `npm ci`).
//
// Usage: npm run lint:cloud-parity
import { rename, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NM = join(ROOT, "node_modules");

// Each entry is [visible, hidden]. Hiding these is what makes TypeScript fall
// back to the `error` type for every Obsidian/CodeMirror symbol.
const LINT_GLOB = "src/**/*.ts";
const HIDDEN = ["obsidian", "@codemirror"];
const TARGETS = HIDDEN.map((name) => [name, `.cloud-parity-hidden-${name.replace(/\W+/g, "-")}`]);

const exists = async (p) => access(p).then(() => true, () => false);

/** Restore every hidden directory. Safe to call repeatedly. */
async function restore() {
  let failed = [];
  for (const [visible, hidden] of TARGETS) {
    const from = join(NM, hidden);
    const to = join(NM, visible);
    if (await exists(from)) {
      try {
        await rename(from, to);
      } catch (e) {
        failed.push(`${hidden} -> ${visible}: ${e.message}`);
      }
    }
  }
  if (failed.length) {
    console.error(
      "\n!! node_modules was left modified. Run `npm ci` to repair:\n  " +
        failed.join("\n  ")
    );
    process.exitCode = 1;
  }
}

// Restore on anything that can end this process, so a crash or Ctrl-C cannot
// leave node_modules in a half-hidden state.
let restoring = false;
const guard = () => {
  if (restoring) return;
  restoring = true;
  // Synchronous fallback: process exit handlers cannot await.
  for (const [visible, hidden] of TARGETS) {
    const from = join(NM, hidden);
    const to = join(NM, visible);
    try {
      spawnSync("mv", [from, to], { stdio: "ignore" });
    } catch {
      /* best effort */
    }
  }
};
process.on("exit", guard);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    guard();
    process.exit(130);
  });
}

try {
  for (const [visible, hidden] of TARGETS) {
    const from = join(NM, visible);
    if (await exists(from)) await rename(from, join(NM, hidden));
  }

  console.log(
    "Linting with the `obsidian` and `@codemirror/*` type declarations hidden,\n" +
      "to mirror what the Obsidian auto-review's scanner appears to see.\n"
  );
  const r = spawnSync("npx", ["eslint", LINT_GLOB, "--format", "json"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // The JSON report for a fully-cascaded run is ~1.1 MB, which overflows
    // spawnSync's 1 MB default and kills the child (status null, truncated
    // stdout). Give it room.
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status === null) {
    console.error("eslint did not exit cleanly:", r.error?.message || "killed by signal");
    process.exitCode = 1;
  }

  let errors = 0;
  let warnings = 0;
  const byRule = new Map();
  const errorRows = [];
  try {
    for (const f of JSON.parse(r.stdout || "[]")) {
      errors += f.errorCount;
      warnings += f.warningCount;
      for (const m of f.messages) {
        byRule.set(m.ruleId || "(none)", (byRule.get(m.ruleId || "(none)") || 0) + 1);
        if (m.severity === 2) errorRows.push(`${f.filePath.replace(`${ROOT}/`, "")}:${m.line}:${m.column}  ${m.ruleId}  ${m.message}`);
      }
    }
  } catch {
    console.error("could not parse eslint output:", (r.stderr || "").slice(0, 300));
    process.exitCode = 1;
  }

  console.log(`${errors} errors, ${warnings} warnings\n`);
  for (const [rule, n] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${rule}`);
  }
  if (errors > 0) process.exitCode = 1;
  if (errorRows.length) console.log(`\nERRORS (these can fail the review):\n${errorRows.map((e) => `  ${e}`).join("\n")}`);
  console.log(
    "\nThese are WARNINGS in the auto-review and do not block a release —\n" +
      "the scorecard's Review verdict stays `Passed`. They are an artifact of\n" +
      "unresolved type declarations, not of defects here: with the same rules\n" +
      "and types resolving, `npm run lint` reports 0/0."
  );
} finally {
  restoring = true;
  await restore();
}
