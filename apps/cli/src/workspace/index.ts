import type { WorkspaceViewV1 } from "@wmm/wire-contracts";
import type { WorkspaceClient } from "./client.js";
import { WorkspaceController } from "./controller.js";

export type { WorkspaceClient } from "./client.js";
export { renderWorkspacePlain } from "./presentation.js";
export { renderAtlasPlain } from "./atlas-renderer.js";

/** Interactive only. The gateway selects plain/JSON output before invoking this. */
export async function runWorkspaceEditor(client: WorkspaceClient, initial: WorkspaceViewV1): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env["TERM"] === "dumb") {
    throw new Error("Workspace editor requires an interactive terminal. Use renderWorkspacePlain for non-TTY or TERM=dumb output.");
  }
  const [{ createElement }, { render }, { WorkspaceEditor }] = await Promise.all([
    import("react"), import("ink"), import("./app.js"),
  ]);
  const controller = new WorkspaceController(client, initial);
  // TTYs are checked above; CI detection must not disable terminal suspension.
  const instance = render(createElement(WorkspaceEditor, { controller }), { patchConsole: false, exitOnCtrlC: true, alternateScreen: true, interactive: true });
  const onInterrupt = (): void => { process.exitCode = 130; instance.unmount(); };
  const onTerminate = (): void => { process.exitCode = 143; instance.unmount(); };
  const onHangup = (): void => { process.exitCode = 129; instance.unmount(); };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  process.once("SIGHUP", onHangup);
  try {
    await instance.waitUntilExit();
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    process.removeListener("SIGHUP", onHangup);
    // Ink restores raw mode, cursor, bracketed paste and the primary screen.
    instance.unmount();
    instance.cleanup();
  }
}
