import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const fixture = fileURLToPath(new URL("../../../fixtures/authoring/faction-project.json", import.meta.url));
function run(args: readonly string[], input?: string) {
  return spawnSync(process.execPath, [main, ...args], { encoding: "utf8", timeout: 10000, ...(input === undefined ? {} : { input }) });
}

describe("agent authoring commands", () => {
  it("checks a project, builds an ordinary inspectable world, and regenerates disposable DM notes", () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-authoring-cli-"));
    try {
      const checked = run(["authoring", "check", fixture]);
      expect(checked.status, checked.stdout + checked.stderr).toBe(0);
      const built = run(["authoring", "build", fixture, "--out", join(root, "bundle")]);
      expect(built.status, built.stdout + built.stderr).toBe(0);
      const validated = run(["world", "validate", join(root, "bundle")]);
      expect(validated.status, validated.stdout + validated.stderr).toBe(0);
      expect(JSON.parse(validated.stdout).data.status).toBe("valid");
      const response = run(["json"], JSON.stringify({ format: "wmm.request/1", apiVersion: "wmm/1", requestId: "authored-world", operation: "world.validate", payload: { bundlePath: join(root, "bundle") } }));
      expect(response.status, response.stdout + response.stderr).toBe(0);
      expect(JSON.parse(response.stdout).outcome).toBe("success");
      const exported = run(["json"], JSON.stringify({ format: "wmm.request/1", apiVersion: "wmm/1", requestId: "authored-export", operation: "world.export", payload: { bundlePath: join(root, "bundle") } }));
      expect(exported.status, exported.stdout + exported.stderr).toBe(0);
      expect(JSON.parse(exported.stdout).outcome).toBe("success");
      const opened = run(["workspace", "open", join(root, "bundle"), "--workspace-dir", join(root, "workspace"), "--json"]);
      expect(opened.status, opened.stdout + opened.stderr).toBe(0);
      expect(JSON.parse(opened.stdout).outcome).toBe("success");
      const rendered = run(["notes", "render", join(root, "bundle"), "--out", join(root, "notes")]);
      expect(rendered.status, rendered.stdout + rendered.stderr).toBe(0);
      expect(readFileSync(join(root, "notes", "faction", "lantern_guild.md"), "utf8")).toContain("Lantern Guild");
      expect(run(["authoring", "build", fixture, "--out", join(root, "bundle")]).status).not.toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 15000);

  it("exposes the closed authoring schema and command help", () => {
    const schema = run(["authoring", "schema"]);
    expect(schema.status, schema.stdout + schema.stderr).toBe(0);
    expect(JSON.parse(schema.stdout).data.$defs.Project.additionalProperties).toBe(false);
    const help = run(["--help"]);
    expect(help.stdout).toContain("wmm authoring build");
    expect(help.stdout).toContain("wmm notes render");
  });

  it.each(["notes", "payload/notes"])("rejects render output inside its input bundle at %s without changing the bundle", (relative) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-authoring-render-boundary-"));
    try {
      const bundle = join(root, "bundle");
      const built = run(["authoring", "build", fixture, "--out", bundle]);
      expect(built.status, built.stdout + built.stderr).toBe(0);
      const snapshot = readFileSync(join(bundle, "snapshot.json"));
      const output = join(bundle, relative);
      const rendered = run(["notes", "render", bundle, "--out", output]);
      expect(rendered.status, rendered.stdout + rendered.stderr).toBe(1);
      expect(existsSync(output)).toBe(false);
      expect(readFileSync(join(bundle, "snapshot.json"))).toEqual(snapshot);
      const validated = run(["world", "validate", bundle]);
      expect(validated.status, validated.stdout + validated.stderr).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects directory-count overflow before creating a destination", () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-authoring-directory-boundary-"));
    try {
      const input = join(root, "input.json");
      writeFileSync(input, JSON.stringify({
        format: "wmm.authoring-project/1", worldId: "world:directory_limit", title: "Directory bound", sources: [], facts: [], campaigns: [],
        entities: Array.from({ length: 1000 }, (_, position) => ({
          id: `person:p${position}`, name: `Person ${position}`, sections: [{ id: "overview", heading: "Overview", category: "lore", context: { kind: "setting" }, text: "Short narrative", references: [], citations: [] }],
        })),
      }));
      const response = run(["authoring", "build", input, "--out", join(root, "bundle")]);
      expect(response.status, response.stdout + response.stderr).toBe(1);
      expect(existsSync(join(root, "bundle"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ["duplicate keys", '{"format":"wmm.authoring-project/1","format":"wmm.authoring-project/1"}'],
    ["invalid UTF-8", Buffer.from([0xff])],
    ["unknown fields", JSON.stringify({ ...JSON.parse(readFileSync(fixture, "utf8")), trusted: true })],
    ["oversized input", " ".repeat(8 * 1024 * 1024 + 1)],
  ])("rejects %s without creating a build directory", (_label, bytes) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-authoring-input-"));
    try {
      const input = join(root, "input.json");
      writeFileSync(input, bytes);
      const response = run(["authoring", "build", input, "--out", join(root, "bundle")]);
      expect(response.status, response.stdout + response.stderr).toBe(1);
      expect(JSON.parse(response.stdout).outcome).toBe("error");
      expect(existsSync(join(root, "bundle"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects symlink input and unexpected output flags", () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-authoring-input-"));
    try {
      const path = join(root, "input.json");
      symlinkSync(fixture, path);
      expect(run(["authoring", "check", path]).status).toBe(1);
      expect(run(["authoring", "build", fixture, "--out", join(root, "bundle"), "--force"]).status).toBe(1);
      expect(existsSync(join(root, "bundle"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
