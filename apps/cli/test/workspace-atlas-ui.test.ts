import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceMapView } from "@wmm/wire-contracts";
import type { WorkspaceClient } from "../src/workspace/client.js";
import { tabs, WorkspaceController } from "../src/workspace/controller.js";
import { renderWorkspaceScreen } from "../src/workspace/presentation.js";
import { WorkspaceEditor } from "../src/workspace/app.js";
import { cells } from "../src/workspace/text.js";
import { mapFixture, workspaceFixture } from "./atlas-fixture.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function harness() {
  const initial = workspaceFixture();
  const read = vi.fn<WorkspaceClient["read"]>(() => initial);
  const mutate = vi.fn<WorkspaceClient["mutate"]>(() => initial);
  const review = vi.fn<NonNullable<WorkspaceClient["review"]>>(() => initial);
  const readMap = vi.fn<NonNullable<WorkspaceClient["readMap"]>>(() => mapFixture());
  const controller = new WorkspaceController({ read, mutate, review, readMap }, initial);
  return { controller, read, mutate, review, readMap, initial };
}

describe("reference atlas controller", () => {
  it("opens and leaves Map inside World using a version-bound read only", () => {
    const { controller, readMap, mutate, read, review, initial } = harness();
    expect(tabs).toEqual(["Changes", "World", "Constraints", "History", "Review"]);
    controller.input("m");
    expect(readMap).not.toHaveBeenCalled();
    controller.input("2"); controller.input("m");
    expect(readMap).toHaveBeenCalledExactlyOnceWith({ atVersion: 7 });
    expect(controller.getSnapshot().atlas.open).toBe(true);
    expect(controller.getSnapshot().atlas.view).toEqual(mapFixture());
    expect(controller.getSnapshot().view).toBe(initial);
    controller.input("m");
    expect(controller.getSnapshot().atlas.open).toBe(false);
    expect(controller.getSnapshot().tab).toBe("World");
    expect(read).not.toHaveBeenCalled(); expect(mutate).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled();
  });
  it("keeps older clients honestly unavailable without throwing or reading an invisible World item", () => {
    const initial = workspaceFixture();
    const read = vi.fn(() => initial); const mutate = vi.fn(() => initial);
    const controller = new WorkspaceController({ read, mutate }, initial);
    controller.input("2"); controller.input("m");
    expect(controller.getSnapshot().atlas.open).toBe(true);
    expect(controller.getSnapshot().atlas.view).toBeNull();
    expect(controller.getSnapshot().atlas.error).toContain("older client");
    expect(controller.getSnapshot().atlas.error).toContain("WorkspaceClient.readMap");
    expect(read).not.toHaveBeenCalled(); expect(mutate).not.toHaveBeenCalled();
  });
  it("retains the workspace and reports a failed map read as unavailable, not an empty ocean", () => {
    const { controller, readMap, initial, read, mutate, review } = harness();
    readMap.mockImplementation(() => { throw new Error("Captured atlas read failed"); });
    controller.input("2"); controller.input("m");
    expect(controller.getSnapshot().atlas.view).toBeNull();
    expect(controller.getSnapshot().atlas.error).toContain("Captured atlas read failed");
    expect(controller.getSnapshot().view).toBe(initial);
    expect(read).not.toHaveBeenCalled(); expect(mutate).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled();
  });
  it.each([
    { workspaceId: "foreign" }, { workspaceVersion: 6 }, { workspaceVersion: 8 },
    { base: { ...mapFixture().base, worldId: "foreign" } },
    { base: { ...mapFixture().base, snapshotDigest: "d".repeat(64) } },
    { selectedProposalsIncluded: true }, { factProjection: "projected" }, { worldBasis: "candidate" }, { candidateView: "available" },
    { atlas: { ...mapFixture().atlas!, worldId: "foreign" } },
    { atlasDigest: null }, { availableAtlases: [] },
  ])("discards mismatched or unsupported map bindings: %j", patch => {
    const { controller, readMap, initial } = harness();
    readMap.mockReturnValue({ ...mapFixture(), ...patch } as WorkspaceMapView);
    controller.input("2"); controller.input("m");
    expect(controller.getSnapshot().atlas.view).toBeNull();
    expect(controller.getSnapshot().atlas.error).toMatch(/binding|unsupported|mismatch/i);
    expect(controller.getSnapshot().view).toBe(initial);
  });
  it("keeps an admitted no-atlas response distinct from a missing capability", () => {
    const { controller, readMap } = harness();
    readMap.mockReturnValue(mapFixture(null));
    controller.input("2"); controller.input("m");
    expect(controller.getSnapshot().atlas.view?.atlas).toBeNull();
    expect(controller.getSnapshot().atlas.error).toBeNull();
  });
  it("renders a no-atlas subview instead of pretending the underlying World row is the map", () => {
    const { controller, readMap } = harness();
    readMap.mockReturnValue(mapFixture(null));
    controller.input("2"); controller.input("m");
    const text = renderWorkspaceScreen(controller.getSnapshot(), 80, 24);
    expect(text).toContain("REFERENCE ATLAS");
    expect(text).toContain("Selected proposals are not shown");
    expect(text).toContain("political facts not projected");
    expect(text).toContain("No reference atlas");
    expect(text).not.toContain("Document | prose/example.md");
  });
  it("navigates stable semantic feature ids, retains the layer and selection on resize, and returns with Esc", () => {
    const { controller, mutate, review, readMap } = harness();
    controller.input("2"); controller.input("m");
    expect(controller.getSnapshot().atlas.selectedFeatureId).toBe("islet");
    controller.input("j");
    expect(controller.getSnapshot().atlas.selectedFeatureId).toBe("upland");
    controller.input("]");
    expect(controller.getSnapshot().atlas.layer).toBe("physical");
    const selection = controller.getSnapshot().atlas;
    for (const [columns, rows] of [[80, 24], [120, 40], [40, 12], [80, 24]]) renderWorkspaceScreen(controller.getSnapshot(), columns!, rows!);
    expect(controller.getSnapshot().atlas).toBe(selection);
    controller.input("", { return: true });
    expect(controller.getSnapshot().detail).toBe(true);
    controller.input("", { escape: true });
    expect(controller.getSnapshot().detail).toBe(false);
    expect(controller.getSnapshot().atlas.open).toBe(true);
    expect(controller.getSnapshot().atlas.selectedFeatureId).toBe("upland");
    controller.input("", { escape: true });
    expect(controller.getSnapshot().atlas.open).toBe(false);
    expect(readMap).toHaveBeenCalledOnce(); expect(mutate).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled();
  });
  it("never pins a hidden World row, evaluates, or selects proposals in Map", () => {
    const { controller, mutate, review } = harness();
    controller.input("2"); controller.input("m");
    for (const shortcut of ["p", "c", " ", "r", "e"]) controller.input(shortcut);
    expect(controller.getSnapshot().modal).toBeNull();
    controller.input("", { return: true });
    expect(mutate).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled();
  });
  it("dispatches m only after forms, help, failure, and paste guards", () => {
    const { controller, readMap, mutate } = harness();
    controller.input("2"); controller.paste("m"); controller.input("mm");
    controller.input("?"); controller.input("m"); controller.input("", { escape: true });
    controller.input("n"); controller.input("m"); controller.paste("m");
    const form = controller.getSnapshot().modal;
    expect(form?.kind).toBe("form");
    if (form?.kind === "form") expect(form.fields[0]!.buffer.text).toBe("No editsmm");
    mutate.mockImplementation(() => { throw new Error("Save failed"); });
    controller.input("s", { ctrl: true }); controller.input("m");
    expect(controller.getSnapshot().failureOpen).toBe(true);
    expect(readMap).not.toHaveBeenCalled();
  });
  it("cycles the service atlas catalog by sorted id with explicit geometry/version binding", () => {
    const { controller, readMap } = harness();
    const base = mapFixture();
    const second = { ...base.atlas!, id: "z-detail", title: "Local reference", geometryVersion: "local-one" };
    const availableAtlases = [{ id: second.id, title: second.title, geometryVersion: second.geometryVersion }, ...base.availableAtlases];
    readMap.mockReturnValueOnce({ ...base, availableAtlases }).mockReturnValueOnce({ ...base, atlas: second, availableAtlases });
    controller.input("2"); controller.input("m"); controller.input("}");
    expect(readMap).toHaveBeenLastCalledWith({ atlasId: "z-detail", geometryVersion: "local-one", atVersion: 7 });
    expect(controller.getSnapshot().atlas.view?.atlas?.id).toBe("z-detail");
    readMap.mockReturnValueOnce({ ...base, availableAtlases });
    controller.input("{");
    expect(readMap).toHaveBeenLastCalledWith({ atlasId: "overview", geometryVersion: "survey-one", atVersion: 7 });
    readMap.mockReturnValue({ ...base, availableAtlases });
    controller.input("}");
    expect(controller.getSnapshot().atlas.view).toBeNull();
    expect(controller.getSnapshot().atlas.error).toContain("binding mismatch");
  });
  it.each([[80, 24], [120, 40]])("uses the real map body at %ix%i, with a full inspector and secondary raw payload", (columns, rows) => {
    const { controller, readMap } = harness();
    controller.input("2");
    expect(renderWorkspaceScreen(controller.getSnapshot(), columns, rows)).toContain("m: map");
    controller.input("m");
    const screen = renderWorkspaceScreen(controller.getSnapshot(), columns, rows);
    expect(screen.split("\n")).toHaveLength(rows - 1);
    expect(screen.split("\n").every(line => line.length < columns)).toBe(true);
    expect(screen).toContain("REFERENCE ATLAS"); expect(screen).toContain("Undated outlines; political facts not projected.");
    expect(screen).toContain("BASE WORLD | Selected proposals are not shown."); expect(screen).toContain("Candidate view unavailable.");
    expect(screen).toContain("m: World"); expect(screen).not.toContain("p: confirm pin");
    expect(screen).not.toContain("No reference atlas");
    expect(screen.includes("INSPECTOR")).toBe(columns >= 100);
    controller.input("", { return: true }, columns);
    let full = "";
    for (let i = 0; i < 15; i++) {
      const text = renderWorkspaceScreen(controller.getSnapshot(), columns, rows, limit => controller.setScrollLimit(limit));
      full += text; controller.input("", { pageDown: true }, columns);
    }
    for (const value of ["Tiny Islet", "place:islet", "source:survey", "Islet marker", "survey-one", "SERVICE-LIMITATION-END"]) expect(full).toContain(value);
    controller.input("d");
    let raw = "";
    for (let i = 0; i < 40; i++) { raw += renderWorkspaceScreen(controller.getSnapshot(), columns, rows); controller.input("", { pageDown: true }, columns); }
    expect(raw).toContain('"selectedProposalsIncluded": false');
    expect(raw).toContain('"atlasDigest"');
    expect(readMap).toHaveBeenCalledOnce();
  });
  it("invalidates a formerly matching map after an acknowledged workspace edit, without an implicit re-read", () => {
    const { controller, readMap, mutate, initial } = harness();
    controller.input("2"); controller.input("m");
    mutate.mockReturnValue({ ...initial, workspace: { ...initial.workspace, version: 8 } });
    controller.input("n"); controller.input("s", { ctrl: true });
    expect(controller.getSnapshot().atlas.view).toBeNull();
    expect(controller.getSnapshot().atlas.error).toContain("binding mismatch");
    const screen = renderWorkspaceScreen(controller.getSnapshot(), 80, 24);
    expect(screen).toContain("MAP UNAVAILABLE"); expect(screen).not.toContain("Tiny Islet");
    expect(readMap).toHaveBeenCalledOnce();
  });
  it("uses a stable mixed-anchor chooser in explicit canvas focus, with no draw-order winner or mutation", () => {
    const { controller, readMap, mutate, review } = harness();
    const base = mapFixture();
    const point = base.atlas!.features[1]!;
    const remote = { ...point, id: "a-remote", label: "Remote point", geometry: { kind: "point" as const, position: [5, 5] as const }, anchor: [5, 5] as const };
    const alpha = { ...point, id: "alpha", label: "Alpha anchor", geometry: { kind: "point" as const, position: [5, 5] as const }, anchor: [50, 30] as const };
    const beta = { ...point, id: "beta", label: "Beta anchor", geometry: { kind: "point" as const, position: [95, 55] as const }, anchor: [50, 30] as const };
    readMap.mockReturnValue({ ...base, atlas: { ...base.atlas!, features: [beta, remote, alpha] } });
    controller.input("2"); controller.input("m"); controller.input("f"); controller.input("", { return: true });
    expect(controller.getSnapshot().atlas.chooser?.featureIds, controller.getSnapshot().status).toEqual(["alpha", "beta"]);
    const chooser = renderWorkspaceScreen(controller.getSnapshot(), 80, 24);
    expect(chooser).toContain("CHOOSE REFERENCE FEATURE"); expect(chooser).toContain("Alpha anchor"); expect(chooser).toContain("Beta anchor");
    controller.input("", { downArrow: true }); controller.input("", { return: true });
    expect(controller.getSnapshot().atlas.selectedFeatureId).toBe("beta");
    expect(controller.getSnapshot().detail).toBe(true);
    controller.input("", { escape: true }); controller.input("", { return: true });
    expect(controller.getSnapshot().atlas.chooser).toBeNull(); // Already-selected beta remains selected in this mixed cell.
    expect(controller.getSnapshot().detail).toBe(true);
    controller.input("", { escape: true }); controller.input("", { end: true }); controller.input("", { return: true });
    expect(controller.getSnapshot().detail).toBe(false);
    expect(controller.getSnapshot().atlas.selectedFeatureId).toBe("beta");
    expect(controller.getSnapshot().status).toContain("Empty cell");
    expect(mutate).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled();
  });
  it("shows the actual no-atlas payload as secondary raw inspection", () => {
    const { controller, readMap } = harness();
    readMap.mockReturnValue(mapFixture(null));
    controller.input("2"); controller.input("m"); controller.input("d");
    expect(renderWorkspaceScreen(controller.getSnapshot(), 80, 24)).toContain("RAW MAP PAYLOAD");
    expect(controller.getSnapshot().raw).toBe(true);
  });
  it("discards a late response if the workspace changed while reading without overwriting a retained form", () => {
    const { controller, readMap, mutate, initial, read } = harness();
    const latest = { ...initial, workspace: { ...initial.workspace, version: 8 } };
    mutate.mockReturnValue(latest);
    let retained: unknown;
    readMap.mockImplementation(() => {
      controller.input("n"); controller.input("s", { ctrl: true });
      controller.input("n"); controller.paste("Retained map buffer"); retained = controller.getSnapshot().modal;
      return mapFixture();
    });
    controller.input("2"); controller.input("m");
    expect(controller.getSnapshot().view).toBe(latest);
    expect(controller.getSnapshot().atlas.view).toBeNull();
    expect(controller.getSnapshot().atlas.error).toContain("binding mismatch");
    expect(controller.getSnapshot().modal).toBe(retained);
    expect(readMap).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled();
  });
  it("isolates actual Ink map keys from bracketed paste and retains subview/layer across resize", async () => {
    const { controller, readMap, mutate, review } = harness();
    readMap.mockReturnValue(mapFixture(null));
    const app = render(createElement(WorkspaceEditor, { controller, columns: 80, rows: 24 }));
    app.stdin.write("2");
    await vi.waitFor(() => expect(controller.getSnapshot().tab).toBe("World"));
    app.stdin.write("\x1b[200~m\x1b[201~");
    await new Promise(resolve => { setTimeout(resolve, 40); });
    expect(readMap).not.toHaveBeenCalled();
    app.stdin.write("m");
    await vi.waitFor(() => expect(app.lastFrame()).toContain("No reference atlas"));
    app.stdin.write("]");
    await vi.waitFor(() => expect(controller.getSnapshot().atlas.layer).toBe("physical"));
    const atlas = controller.getSnapshot().atlas;
    for (const [columns, rows] of [[120, 40], [40, 12], [80, 24]]) {
      app.rerender(createElement(WorkspaceEditor, { controller, columns: columns!, rows: rows! }));
      await vi.waitFor(() => expect(app.lastFrame()).toContain(columns! < 80 ? "Terminal too small" : "REFERENCE ATLAS"));
      expect(app.lastFrame()?.split("\n").every(line => cells(line) < columns!)).toBe(true);
    }
    expect(controller.getSnapshot().atlas).toBe(atlas);
    app.stdin.write("p");
    await new Promise(resolve => { setTimeout(resolve, 40); });
    expect(controller.getSnapshot().modal).toBeNull();
    expect(mutate).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled();
    app.stdin.write("m"); await vi.waitFor(() => expect(controller.getSnapshot().atlas.open).toBe(false));
    expect(readMap).toHaveBeenCalledOnce();
  });
});
