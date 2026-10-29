import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAuthoringProject } from "@wmm/application";
import { describe, expect, it } from "vitest";

const example = fileURLToPath(new URL("../../../examples/harness/dm-import.json", import.meta.url));

interface ExampleRequest {
  readonly format: string;
  readonly mode: string;
  readonly projectPath: string;
  readonly sourceRoot: string;
  readonly task: string;
  readonly sources: readonly { readonly id: string; readonly title: string; readonly path: string }[];
}

describe("public DM harness example", () => {
  it("ships a selected synthetic source and a nonempty admitted baseline", () => {
    const request = JSON.parse(readFileSync(example, "utf8")) as ExampleRequest;
    expect(request.format).toBe("wmm.dm-harness-request/1");
    expect(request.mode).toBe("dm-import");
    expect(request.sources).toHaveLength(1);
    const project = JSON.parse(readFileSync(resolve(dirname(example), request.projectPath), "utf8"));
    expect(() => checkAuthoringProject(project)).not.toThrow();
    expect(project.entities.flatMap((entity: { sections: unknown[] }) => entity.sections).length).toBeGreaterThan(0);
    expect(project.facts.length).toBeGreaterThan(0);
    expect(project.campaigns[0].tracks[0].entries).toHaveLength(2);
    const source = request.sources[0]!;
    const bytes = readFileSync(resolve(dirname(example), request.sourceRoot, source.path));
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    expect(text).toContain("Lantern Beacon Guild");
    expect(text).toContain("not record a strike");
    expect(request.task).toContain("Preserve");
  });
});
