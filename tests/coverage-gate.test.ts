import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Pins the coverage ratchet in vitest.config.mts so a small diff cannot loosen
// it: thresholds only go up, nothing is excluded, nothing is hidden behind an
// ignore comment. Unreachable code is deleted, not ignored.
const root = path.resolve(__dirname, "..");
const config = readFileSync(path.join(root, "vitest.config.mts"), "utf8");
const coverage = config.slice(config.indexOf("coverage: {"));

// The ratchet. Raise these as coverage grows; the test fails if the config is
// below them, so a lowered threshold cannot be merged unnoticed.
const FLOOR = { lines: 51, functions: 82, branches: 88, statements: 51 };

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return p.endsWith(".ts") ? [p] : [];
  });
}

function listOf(key: string): string[] {
  const block = new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`).exec(coverage)?.[1] ?? "";
  return block
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, "").trim())
    .join("")
    .split(",")
    .map((e) => e.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

describe("coverage gate", () => {
  it("uses the v8 provider and counts unimported files", () => {
    expect(coverage).toMatch(/provider:\s*"v8"/);
    expect(coverage).toMatch(/all:\s*true/);
  });

  it("never sits below the ratchet", () => {
    const block = /thresholds:\s*\{([^}]*)\}/.exec(coverage)![1];
    for (const [metric, floor] of Object.entries(FLOOR)) {
      const value = Number(new RegExp(`${metric}:\\s*(\\d+(?:\\.\\d+)?)`).exec(block)?.[1]);
      expect(value, metric).toBeGreaterThanOrEqual(floor);
    }
  });

  it("measures all of src/", () => {
    expect(listOf("include")).toEqual(["src/**/*.ts"]);
  });

  it("excludes nothing but declaration files", () => {
    expect(listOf("exclude")).toEqual(["src/**/*.d.ts"]);
  });

  it("has no coverage-ignore comments in the source", () => {
    const offenders = sourceFiles(path.join(root, "src")).filter((f) =>
      /(?:\/\*|\/\/)\s*(?:v8|c8|istanbul)\s+ignore/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
