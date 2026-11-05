import { describe, expect, it } from "vitest";
import {
  checkAllowScripts,
  checkDependabotCooldown,
  checkNpmrc,
  compareDotted,
  npmSupportsMinReleaseAge,
} from "../scripts/lib/supplyChainChecks.mjs";

const dependabot = (npmDays: string, actionsDays: string) => `
version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    # cooldown: { default-days: 1 }
    cooldown:
      default-days: ${npmDays}
      semver-major-days: 30
  - package-ecosystem: github-actions
    directory: "/"
    cooldown:
      default-days: ${actionsDays}
`;

describe("compareDotted", () => {
  it("orders X.Y.Z numerically, not lexically", () => {
    expect(compareDotted("11.10.0", "11.9.0")).toBe(1);
    expect(compareDotted("11.9.0", "11.10.0")).toBe(-1);
    expect(compareDotted("11.10", "11.10.0")).toBe(0);
  });
});

describe("npmSupportsMinReleaseAge", () => {
  it("needs npm >= 11.10", () => {
    expect(npmSupportsMinReleaseAge("11.10.0")).toBe(true);
    expect(npmSupportsMinReleaseAge("11.20.0")).toBe(true);
    expect(npmSupportsMinReleaseAge("11.9.0")).toBe(false);
    expect(npmSupportsMinReleaseAge("10.9.2")).toBe(false);
    expect(npmSupportsMinReleaseAge("")).toBe(false);
    expect(npmSupportsMinReleaseAge(undefined)).toBe(false);
  });
});

describe("checkNpmrc", () => {
  it("accepts >= 14 days", () => {
    expect(checkNpmrc('tag-version-prefix=""\nmin-release-age=14\n')).toMatchObject({ ok: true, days: 14 });
    expect(checkNpmrc("min-release-age = 30").ok).toBe(true);
  });
  it("rejects a missing, short, non-numeric or commented-out setting", () => {
    expect(checkNpmrc(undefined as unknown as string).ok).toBe(false);
    expect(checkNpmrc("").problem).toMatch(/does not set/);
    expect(checkNpmrc("min-release-age=7").problem).toMatch(/minimum is 14/);
    expect(checkNpmrc("min-release-age=soon").problem).toMatch(/whole number/);
    expect(checkNpmrc("# min-release-age=14").ok).toBe(false);
  });
});

describe("checkDependabotCooldown", () => {
  it("accepts a 14-day cooldown on both ecosystems", () => {
    expect(checkDependabotCooldown(dependabot("14", "14"))).toEqual({ ok: true, problems: [] });
  });
  it("rejects short, missing or commented-out cooldowns", () => {
    expect(checkDependabotCooldown(dependabot("3", "14")).problems).toEqual([
      '"npm" cooldown default-days is 3, policy minimum is 14',
    ]);
    expect(checkDependabotCooldown(dependabot("14", "7")).ok).toBe(false);
    expect(checkDependabotCooldown(undefined as unknown as string).ok).toBe(false);
    const noCooldown = "updates:\n  - package-ecosystem: npm\n    directory: /\n";
    expect(checkDependabotCooldown(noCooldown).problems).toEqual([
      '"npm" has no cooldown block',
      'no "github-actions" ecosystem in dependabot.yml',
    ]);
    const noDays = "updates:\n  - package-ecosystem: npm\n    cooldown:\n      semver-major-days: 30\n";
    expect(checkDependabotCooldown(noDays, 14, ["npm"]).problems).toEqual(['"npm" cooldown has no default-days']);
  });
});

describe("checkAllowScripts", () => {
  it("passes when nothing is approved", () => {
    expect(checkAllowScripts({ esbuild: false })).toMatchObject({ ok: true, denied: ["esbuild"] });
  });
  it("fails when the field is missing or anything is approved", () => {
    expect(checkAllowScripts(undefined).ok).toBe(false);
    expect(checkAllowScripts([]).ok).toBe(false);
    expect(checkAllowScripts({ esbuild: true, fsevents: false })).toMatchObject({ ok: false, approved: ["esbuild"] });
  });
});
