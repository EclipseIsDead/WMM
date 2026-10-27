import { mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeApiRequest } from "@wmm/application";
import type { ApplicationServices } from "@wmm/application";
import { buildAuthoringBundle, readEconomyView } from "@wmm/exchange";
import type { WorkspaceClient } from "../src/workspace/client.js";
import * as gateway from "../src/workspace-command.js";
import { WorkspaceController } from "../src/workspace/controller.js";
import { renderWorkspaceScreen } from "../src/workspace/presentation.js";

describe("host-constructed Economy client", () => {
  it("supplies the actual application capability to World after SQLite reopen and source loss", () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-economy-client-"));
    try {
      const bundlePath = join(root, "bundle"), directory = join(root, "workspace");
      const bundle = buildAuthoringBundle(JSON.parse(readFileSync(new URL("../../../fixtures/authoring/grain-project.json", import.meta.url), "utf8")), bundlePath);
      const expected = readEconomyView(bundle);
      let runtime = gateway.openWorkspaceRuntime(directory);
      try {
        const created = executeApiRequest({ format: "wmm.request/1", apiVersion: "wmm/1", requestId: "create", operation: "workspace.create", payload: { workspaceId: "main", bundlePath, title: "Economy", goal: "Read only", mode: "world", idempotencyKey: "create" } }, runtime.services);
        expect(created.outcome).toBe("success");
      } finally { runtime.close(); }
      renameSync(bundlePath, join(root, "gone"));
      runtime = gateway.openWorkspaceRuntime(directory, false);
      try {
        const make = (gateway as unknown as Record<string, unknown>)["createWorkspaceClient"];
        expect(typeof make, "missing real host WorkspaceClient factory").toBe("function");
        const client = (make as (services: ApplicationServices, id: string) => WorkspaceClient)(runtime.services, "main");
        expect(typeof client.readEconomy).toBe("function");
        client.mutate({ kind: "put-proposal", proposal: { id: "prose", title: "Excluded draft", rationale: "No stock changes", author: "Synthetic", dependencies: [], exclusions: [], operations: [{ kind: "write-prose", path: "prose/new.md", beforeSha256: null, text: "A selected prose proposal is not an economic record." }] } }, 1, "prose");
        client.mutate({ kind: "decide", groupId: "prose", decision: "selected" }, 2, "select");
        client.review?.(3);
        runtime.close(); runtime = gateway.openWorkspaceRuntime(directory, false);
        const reopened = (make as (services: ApplicationServices, id: string) => WorkspaceClient)(runtime.services, "main");
        const initial = reopened.read();
        expect(initial.workspace.version).toBe(3); expect(initial.workspace.proposals[0]?.decision).toBe("selected");
        expect(initial.review?.binding.workspaceVersion).toBe(3);
        expect(reopened.readEconomy?.({ atVersion: 3 }).economy).toEqual(expected);
        const controller = new WorkspaceController(reopened, initial);
        controller.input("2"); controller.input("o");
        expect(renderWorkspaceScreen(controller.getSnapshot(), 80, 24)).toContain("600 t");
        expect(controller.getSnapshot().economy.view?.economy).toEqual(expected);
        controller.input("]"); controller.input("]"); controller.input("", { return: true });
        for (const [columns, rows] of [[120, 40], [80, 24], [40, 12], [120, 40]]) renderWorkspaceScreen(controller.getSnapshot(), columns!, rows!);
        for (const shortcut of ["p", "a", "n", "e", "r", "c", " "]) controller.input(shortcut);
        controller.input("", { pageDown: true }); controller.input("o");
        expect(reopened.read()).toEqual(initial);
      } finally { runtime.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
