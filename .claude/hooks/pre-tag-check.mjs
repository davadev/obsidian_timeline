#!/usr/bin/env node
// Claude Code PreToolUse hook for Bash (registered by .claude/settings.json). Before the
// agent creates or pushes a SemVer release tag it runs the release guard plus lint
// (`npm run check-release -- --with-lint`); a failure blocks the command (exit 2). It also
// blocks `gh release create|upload|edit|delete` and `git push --tags|--follow-tags`
// outright. Any other command passes straight through (exit 0). The workflow re-checks on
// the runner; failing before the push is just cheaper than undoing a bad tag.
import { spawnSync } from "node:child_process";
import { classifyReleaseCommand } from "../../scripts/lib/releaseChecks.mjs";

let input = "";
for await (const chunk of process.stdin) input += chunk;

let command = "";
try {
  command = JSON.parse(input)?.tool_input?.command ?? "";
} catch {
  process.exit(0);
}

const verdict = classifyReleaseCommand(command);
if (verdict === "allow") process.exit(0);
const BLOCKED = {
  "block-release-cmd": "Blocked: releases are published by release.yml from a tag. Use the release-beta / release-stable skill, not `gh release`.",
  "block-push-tags": "Blocked: push the one tag by name (`git push origin <tag>`), never --tags or --follow-tags.",
};
if (verdict !== "needs-check") {
  process.stderr.write(`${BLOCKED[verdict]}\n`);
  process.exit(2);
}

const run = spawnSync("npm", ["run", "check-release", "--", "--with-lint"], { encoding: "utf8", cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd() });
if (run.status === 0) process.exit(0);

process.stderr.write(
  `Release tag blocked: \`npm run check-release -- --with-lint\` failed (exit ${run.status}).\n` +
    `Fix it (see the release-beta skill) before tagging.\n\n${(run.stdout || "").split("\n").slice(-40).join("\n")}\n${run.stderr || ""}`
);
process.exit(2);
