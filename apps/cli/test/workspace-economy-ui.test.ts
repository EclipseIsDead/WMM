import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceController } from "../src/workspace/controller.js";
import type { WorkspaceEconomyView } from "@wmm/wire-contracts";
import type { WorkspaceClient } from "../src/workspace/client.js";
import { renderWorkspaceScreen } from "../src/workspace/presentation.js";
import { economyFixture, economyWorkspaceFixture } from "./economy-fixture.js";
import { WorkspaceEditor } from "../src/workspace/app.js";
import { cells } from "../src/workspace/text.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("World → Economy read-only inspection", () => {
  it.each([false, true])("reports an unavailable optional capability or failed read honestly (failure=%s)", failure => {
    const { initial } = economyWorkspaceFixture();
    const read = vi.fn(() => initial), mutate = vi.fn(() => initial), review = vi.fn(() => initial);
    const controller = new WorkspaceController({ read, mutate, review, ...(failure ? { readEconomy: () => { throw new Error("Retained economy read failed\x1b[31m"); } } : {}) }, initial);
    controller.input("2"); controller.input("o");
    expect(controller.getSnapshot().economy.view).toBeNull();
    expect(controller.getSnapshot().economy.error).toMatch(failure ? /Retained economy read failed/ : /older client.*WorkspaceClient.readEconomy/i);
    const screen = renderWorkspaceScreen(controller.getSnapshot(), 80, 24);
    expect(screen).toContain("ECONOMY UNAVAILABLE"); expect(screen).not.toContain("600 t"); expect(screen).not.toContain("\x1b");
    controller.input("p"); controller.input("a"); controller.input("n"); controller.input("c");
    expect(controller.getSnapshot().modal).toBeNull();
    controller.input("", { escape: true });
    expect(controller.getSnapshot().economy.open).toBe(false);
    expect(read).not.toHaveBeenCalled(); expect(mutate).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled();
  });
  it("keeps forms, help, failed saves, paste and modifiers ahead of the Economy open shortcut", () => {
    const { initial, result } = economyWorkspaceFixture();
    const readEconomy = vi.fn(() => result), mutate = vi.fn(() => { throw new Error("unconfirmed"); });
    const controller = new WorkspaceController({ read: () => initial, mutate, readEconomy }, initial);
    controller.input("2"); controller.paste("o"); controller.input("oo"); controller.input("o", { ctrl: true });
    controller.input("?"); controller.input("o"); controller.input("", { escape: true });
    controller.input("n"); controller.input("o"); controller.paste("o");
    const form = controller.getSnapshot().modal;
    expect(form?.kind).toBe("form");
    if (form?.kind === "form") expect(form.fields[0]!.buffer.text).toBe("No editsoo");
    controller.input("s", { ctrl: true }); controller.input("o");
    expect(controller.getSnapshot().failureOpen).toBe(true); expect(readEconomy).not.toHaveBeenCalled();
  });
  it("preserves per-category row navigation and the hidden World index across resize", () => {
    const economy = economyFixture(project => ({ ...project, economy: { format: "wmm.authoring-economy/1", records: [...project.economy!.records, ...["second", "third"].map(id => ({ ...project.economy!.records[0]!, id }))] } }));
    const { initial, result } = economyWorkspaceFixture(economy);
    const readEconomy = vi.fn(() => result);
    const controller = new WorkspaceController({ read: () => initial, mutate: () => initial, readEconomy }, initial);
    controller.input("2"); controller.input("j"); const worldIndex = controller.getSnapshot().indices.World;
    controller.input("o"); controller.input("j");
    expect(controller.getSnapshot().economy.indices["stock-observation"]).toBe(1);
    controller.input("", { pageDown: true });
    expect(controller.getSnapshot().economy.indices["stock-observation"]).toBe(2);
    controller.input("]"); controller.input("[");
    expect(controller.getSnapshot().economy.indices["stock-observation"]).toBe(2);
    const before = controller.getSnapshot();
    for (const [columns, rows] of [[120, 40], [80, 24], [40, 12], [120, 40]]) {
      const screen = renderWorkspaceScreen(controller.getSnapshot(), columns!, rows!);
      expect(screen.split("\n").every(line => cells(line) < columns!)).toBe(true);
    }
    expect(controller.getSnapshot()).toBe(before);
    controller.input("", { upArrow: true });
    expect(controller.getSnapshot().economy.indices["stock-observation"]).toBe(1);
    controller.input("o"); expect(controller.getSnapshot().indices.World).toBe(worldIndex);
    expect(readEconomy).toHaveBeenCalledOnce();
  });
  it("uses actual Ink keys with bracketed-paste isolation, category/detail/back and wide→narrow→wide resize", async () => {
    const { initial, result } = economyWorkspaceFixture();
    const readEconomy = vi.fn(() => result), mutate = vi.fn(() => initial), review = vi.fn(() => initial);
    const controller = new WorkspaceController({ read: () => initial, mutate, review, readEconomy }, initial);
    const app = render(createElement(WorkspaceEditor, { controller, columns: 120, rows: 40 }));
    app.stdin.write("2"); await vi.waitFor(() => expect(controller.getSnapshot().tab).toBe("World"));
    app.stdin.write("\x1b[200~o\x1b[201~");
    await new Promise(resolve => { setTimeout(resolve, 40); }); expect(readEconomy).not.toHaveBeenCalled();
    app.stdin.write("o"); await vi.waitFor(() => expect(app.lastFrame()).toContain("STOCK OBSERVATIONS"));
    app.stdin.write("]"); await vi.waitFor(() => expect(app.lastFrame()).toContain("FUTURE COMMITMENTS"));
    app.stdin.write("\r"); await vi.waitFor(() => expect(app.lastFrame()).toContain("Quantity (bounded): [200, 250] t"));
    const economy = controller.getSnapshot().economy;
    for (const [columns, rows] of [[80, 24], [40, 12], [120, 40]]) {
      app.rerender(createElement(WorkspaceEditor, { controller, columns: columns!, rows: rows! }));
      await vi.waitFor(() => expect(app.lastFrame()).toContain(columns! < 80 ? "Terminal too small" : "FUTURE COMMITMENTS"));
      expect(app.lastFrame()?.split("\n").every(line => cells(line) < columns!)).toBe(true);
    }
    expect(controller.getSnapshot().economy).toBe(economy);
    app.stdin.write("p"); await vi.waitFor(() => expect(controller.getSnapshot().status).toContain("Economy is read-only"));
    app.stdin.write("\x1b"); await vi.waitFor(() => expect(controller.getSnapshot().detail).toBe(false));
    app.stdin.write("\x1b"); await vi.waitFor(() => expect(controller.getSnapshot().economy.open).toBe(false));
    expect(mutate).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled(); expect(readEconomy).toHaveBeenCalledOnce();
  });
  it("documents the Economy open/back/category/read-only keys in the real keyboard guide", () => {
    const { initial } = economyWorkspaceFixture();
    const controller = new WorkspaceController({ read: () => initial, mutate: () => initial }, initial);
    controller.input("?");
    let guide = "";
    for (let page = 0; page < 5; page++) { guide += renderWorkspaceScreen(controller.getSnapshot(), 80, 24); controller.input("", { pageDown: true }); }
    expect(guide).toContain("World o: Economy");
    expect(guide).toContain("[ ]: categories");
    expect(guide).toContain("Economy is read-only");
  });
  it("blocks every mutation/edit/pin/review shortcut while Economy hides World rows, with a read-only explanation", () => {
    const { initial, result } = economyWorkspaceFixture();
    const read = vi.fn(() => initial), mutate = vi.fn(() => initial), review = vi.fn(() => initial), readEconomy = vi.fn(() => result);
    const controller = new WorkspaceController({ read, mutate, review, readEconomy }, initial);
    controller.input("2"); controller.input("o");
    for (const mode of ["list", "detail", "raw"]) {
      if (mode === "detail") controller.input("", { return: true });
      if (mode === "raw") controller.input("d");
      for (const shortcut of ["p", "a", "n", "e", "r", "c", " "]) {
        controller.input(shortcut);
        expect(controller.getSnapshot().modal).toBeNull();
        expect(controller.getSnapshot().status).toContain("Economy is read-only");
      }
      controller.input("s", { ctrl: true }); controller.input("", { ctrl: true, return: true });
    }
    expect(read).not.toHaveBeenCalled(); expect(mutate).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled();
    expect(controller.getSnapshot().view).toBe(initial);
    controller.input("o"); controller.input("n");
    expect(controller.getSnapshot().modal?.kind).toBe("form");
  });
  it("invalidates a retained Economy read when an acknowledged edit changes the workspace version", () => {
    const { initial, result } = economyWorkspaceFixture();
    const latest = { ...initial, workspace: { ...initial.workspace, version: initial.workspace.version + 1 } };
    const readEconomy = vi.fn(() => result), mutate = vi.fn(() => latest);
    const controller = new WorkspaceController({ read: () => initial, mutate, readEconomy }, initial);
    controller.input("2"); controller.input("o"); controller.input("1");
    controller.input("n"); controller.input("s", { ctrl: true }); controller.input("2");
    expect(controller.getSnapshot().economy.view).toBeNull();
    expect(controller.getSnapshot().economy.error).toContain("binding mismatch");
    expect(renderWorkspaceScreen(controller.getSnapshot(), 80, 24)).not.toContain("600 t");
    expect(readEconomy).toHaveBeenCalledOnce();
  });
  it.each([[80, 24], [120, 40]])("navigates categories and full shared readable details at %ix%i without writes", (columns, rows) => {
    const { initial, result } = economyWorkspaceFixture();
    const readEconomy = vi.fn(() => result), mutate = vi.fn(() => initial), review = vi.fn(() => initial);
    const controller = new WorkspaceController({ read: () => initial, mutate, review, readEconomy }, initial);
    controller.input("2"); controller.input("o"); controller.input("]");
    expect(renderWorkspaceScreen(controller.getSnapshot(), columns, rows)).toContain("FUTURE COMMITMENTS");
    expect(renderWorkspaceScreen(controller.getSnapshot(), columns, rows)).toContain("[200, 250] t");
    controller.input("]");
    const list = renderWorkspaceScreen(controller.getSnapshot(), columns, rows);
    expect(list).toContain("PLANNED REQUIREMENTS"); expect(list).toContain("unknown t");
    expect(list.includes("INSPECTOR")).toBe(columns >= 100);
    controller.input("", { return: true }, columns, rows);
    let details = "";
    for (let page = 0; page < 25; page++) {
      details += renderWorkspaceScreen(controller.getSnapshot(), columns, rows, limit => controller.setScrollLimit(limit));
      controller.input("", { pageDown: true }, columns, rows);
    }
    for (const text of ["food-plan", "account:campaign_rainwatch", "unmapped", "Planner:", "Beneficiary:", "Purpose:", "Method: unknown", "Boundary:", "Coverage: unknown", "Opening entry", "source:ledger", "Semantic profile:", "Captured input:", "Base snapshot:", "SERVICE-ECONOMY-LIMITATION-END"]) expect(details).toContain(text);
    controller.input("", { escape: true }, columns, rows);
    expect(controller.getSnapshot().detail).toBe(false);
    controller.input("[");
    expect(renderWorkspaceScreen(controller.getSnapshot(), columns, rows)).toContain("FUTURE COMMITMENTS");
    controller.input("d");
    expect(renderWorkspaceScreen(controller.getSnapshot(), columns, rows)).toContain("RAW ECONOMY PAYLOAD");
    controller.input("", { escape: true }); controller.input("", { escape: true });
    expect(controller.getSnapshot().economy.open).toBe(false);
    expect(controller.getSnapshot().view).toBe(initial);
    expect(readEconomy).toHaveBeenCalledOnce(); expect(mutate).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled();
  });
  it.each(["workspaceId", "older", "newer", "world", "snapshot", "economy-world", "economy-snapshot", "profile", "input", "candidate", "included", "basis", "malformed"])("discards unsupported or mismatched %s bindings before display", kind => {
    const { initial, result } = economyWorkspaceFixture();
    const changes: Record<string, unknown> = {
      workspaceId: { workspaceId: "foreign" }, older: { workspaceVersion: initial.workspace.version - 1 }, newer: { workspaceVersion: initial.workspace.version + 1 },
      world: { base: { ...result.base, worldId: "world:foreign" } }, snapshot: { base: { ...result.base, snapshotDigest: "d".repeat(64) } },
      "economy-world": { economy: { ...result.economy, worldId: "world:foreign" } }, "economy-snapshot": { economy: { ...result.economy, snapshotDigest: "d".repeat(64) } },
      profile: { economy: { ...result.economy, semanticProfileDigest: "d".repeat(64) } }, input: { economy: { ...result.economy, inputDigest: "not-a-digest" } },
      candidate: { candidateView: "available" }, included: { selectedProposalsIncluded: true }, basis: { worldBasis: "candidate" }, malformed: { economy: null },
    };
    const readEconomy = () => ({ ...result, ...(changes[kind] as object) }) as WorkspaceEconomyView;
    const controller = new WorkspaceController({ read: () => initial, mutate: () => initial, readEconomy }, initial);
    controller.input("2"); controller.input("o");
    expect(controller.getSnapshot().economy.view).toBeNull();
    expect(controller.getSnapshot().economy.error).toMatch(/binding|unsupported|mismatch/i);
    expect(renderWorkspaceScreen(controller.getSnapshot(), 80, 24)).toContain("ECONOMY UNAVAILABLE");
    expect(renderWorkspaceScreen(controller.getSnapshot(), 80, 24)).not.toContain("600 t");
    expect(controller.getSnapshot().view).toBe(initial);
  });
  it("opens a version-bound real Economy read and displays it instead of hidden World rows", () => {
    const { initial, result } = economyWorkspaceFixture();
    const read = vi.fn(() => initial), mutate = vi.fn(() => initial), review = vi.fn(() => initial);
    const readEconomy = vi.fn(() => result);
    const client = { read, mutate, review, readEconomy } satisfies WorkspaceClient & { readEconomy: typeof readEconomy };
    const controller = new WorkspaceController(client, initial);
    controller.input("o"); expect(readEconomy).not.toHaveBeenCalled();
    controller.input("2");
    expect(renderWorkspaceScreen(controller.getSnapshot(), 80, 24)).toContain("o: economy");
    controller.input("o");
    expect(readEconomy).toHaveBeenCalledExactlyOnceWith({ atVersion: initial.workspace.version });
    const screen = renderWorkspaceScreen(controller.getSnapshot(), 80, 24);
    expect(screen).toContain("ECONOMY / DM / READ-ONLY");
    expect(screen).toContain("STOCK OBSERVATIONS"); expect(screen).toContain("600 t");
    expect(screen).toContain("Selected proposals excluded"); expect(screen).toContain("candidate unavailable");
    expect(screen).not.toContain("Document | prose/example.md");
    expect(screen).toContain("o: World"); expect(screen).not.toContain("p: confirm pin");
    controller.input("o");
    expect(renderWorkspaceScreen(controller.getSnapshot(), 80, 24)).toContain("BASE WORLD / READ-ONLY");
    expect(controller.getSnapshot().view).toBe(initial);
    expect(read).not.toHaveBeenCalled(); expect(mutate).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled();
  });
});
