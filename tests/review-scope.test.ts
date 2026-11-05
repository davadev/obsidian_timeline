import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The community-plugin review lints tracked source except a fixed list of
// ignored names (*.test.*, tests, mocks, scripts, docs, *.mjs ...). A helper
// that lands in tests/ without ".test." in its name, or a new top-level code
// folder, becomes part of the plugin's score. Keep helpers in testUtils/.
const root = path.resolve(__dirname, "..");
const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

describe("review scope", () => {
  it("tests/ holds only *.test.ts files", () => {
    const strays = tracked.filter((f) => f.startsWith("tests/") && !/\.test\.ts$/.test(f));
    expect(strays).toEqual([]);
  });

  it("no scanned code file lives outside src/ and the ignored folders", () => {
    const code = /\.(?:ts|tsx|js|jsx)$/;
    const allowed = /^(?:src|tests|testUtils|scripts|docs|demo-vault)\/|^[^/]+\.(?:mjs|cjs|mts)$|^main\.js$/;
    const offenders = tracked.filter((f) => code.test(f) && !allowed.test(f));
    expect(offenders).toEqual([]);
  });
});
