import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const repository = new URL("../../../", import.meta.url);

describe("all-fixtures CI wiring", () => {
  it("exposes one local fixture entry point and runs fixtures independently of unit-test success", () => {
    const manifest = JSON.parse(readFileSync(new URL("package.json", repository), "utf8")) as { scripts: Record<string, string> };
    expect(manifest.scripts["verify:fixtures"]).toBe("pnpm build && node tools/verify-fixtures.mjs");
    const workflow = readFileSync(new URL(".github/workflows/check.yml", repository), "utf8");
    const fixtures = workflow.split("\n  fixtures:\n")[1];
    expect(fixtures).toBeDefined();
    expect(fixtures).not.toMatch(/^\s+needs:/m);
    expect(fixtures).toContain("os: [ubuntu-latest, macos-latest]");
    expect(fixtures).toContain("pnpm verify:fixtures");
    expect(fixtures).toContain("pnpm verify:workspace");
    expect(fixtures).toContain("pnpm generate:fixtures");
    expect(fixtures).toContain("git ls-files --others --exclude-standard -- fixtures/");
    expect(fixtures?.match(/!cancelled\(\) && steps\.build\.outcome == 'success'/g)).toHaveLength(3);
  });
  it("bounds test concurrency and establishes a canonical temporary directory on each runner", () => {
    const workflow = readFileSync(new URL(".github/workflows/check.yml", repository), "utf8");
    expect(workflow).toContain('VITEST_MAX_WORKERS: "2"');
    expect(workflow.match(/realpathSync\(process\.env\.RUNNER_TEMP\)/g)).toHaveLength(2);
    expect(workflow.match(/process\.env\.GITHUB_ENV/g)).toHaveLength(2);
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toContain("pull_request_target");
  });
});
