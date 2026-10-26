import { createElement, useEffect, useSyncExternalStore } from "react";
import { Text, useApp, useInput, usePaste, useStdout, useWindowSize } from "ink";
import type { WorkspaceController } from "./controller.js";
import { renderWorkspaceScreen } from "./presentation.js";
import { detectAtlasColourMode, shadeAtlasScreen } from "./atlas-shader.js";
import type { AtlasPaint } from "./atlas-shader.js";

export interface WorkspaceEditorProps {
  readonly controller: WorkspaceController;
  /** Optional fixed dimensions for embedding/tests; otherwise Ink tracks resize. */
  readonly columns?: number;
  readonly rows?: number;
}

export function WorkspaceEditor({ controller, columns, rows }: WorkspaceEditorProps): ReturnType<typeof createElement> {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const size = useWindowSize();
  const { stdout } = useStdout();
  const { exit, suspendTerminal } = useApp();
  useInput((input, key) => {
    if (key.eventType === "release") return;
    if (key.ctrl && input === "e" && state.externalEditorAvailable) {
      void controller.editExternally(suspendTerminal);
      return;
    }
    controller.input(input, key, columns ?? size.columns, rows ?? size.rows);
  });
  // Keep paste active even outside forms: a pasted "q" must never quit the editor.
  // Ink owns chunk buffering, raw mode, bracketed-paste setup and teardown.
  usePaste(text => { controller.paste(text); });
  useEffect(() => { if (state.quit) exit(); }, [state.quit, exit]);
  let scrollLimit = Number.POSITIVE_INFINITY;
  let paint: AtlasPaint | undefined;
  const screen = renderWorkspaceScreen(state, columns ?? size.columns, rows ?? size.rows, limit => { scrollLimit = limit; }, raster => { paint = raster; });
  useEffect(() => { controller.setScrollLimit(scrollLimit); }, [controller, scrollLimit, state]);
  const mode = detectAtlasColourMode(stdout, process.env);
  if (!paint || mode === "none") return createElement(Text, { wrap: "truncate" }, screen);
  const runs = shadeAtlasScreen(screen, paint, mode);
  return createElement(Text, { wrap: "truncate" }, runs.map((run, index) => Object.keys(run.style).length
    ? createElement(Text, { key: index, ...run.style }, run.text) : run.text));
}
