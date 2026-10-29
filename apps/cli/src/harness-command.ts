import { captureDmHarnessInput, HarnessInputError, resolveDmHarnessRunDirectory } from "./harness-input.js";

export { HarnessInputError };

export class HarnessCommandError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "HarnessCommandError";
  }
}

function usage(): never {
  throw new HarnessCommandError("HARNESS_USAGE_ERROR", "Usage: wmm harness run <request.json> --out <fresh-run-directory> [--model <model>] [--provider <provider>] | wmm harness resume <run-directory> [--model <model>] [--provider <provider>]");
}

function argument(value: string | undefined, maximum: number): value is string {
  return value !== undefined && !!value.trim() && !value.startsWith("-") &&
    value.length <= maximum && value.isWellFormed() && !/[\u0000-\u001f\u007f]/.test(value);
}

interface HarnessOptions { model?: string; provider?: string }
type HarnessArguments =
  | { readonly command: "run"; readonly path: string; readonly destination: string; readonly options: HarnessOptions }
  | { readonly command: "resume"; readonly path: string; readonly options: HarnessOptions };

function parseArguments(args: readonly string[]): HarnessArguments {
  const [command, path] = args;
  if ((command !== "run" && command !== "resume") || !argument(path, 4096)) usage();
  let destination: string | undefined;
  const options: HarnessOptions = {};
  const seen = new Set<string>();
  for (let index = 2; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || !["--out", "--model", "--provider"].includes(flag) || seen.has(flag) ||
      (command === "resume" && flag === "--out") ||
      !argument(value, flag === "--out" ? 4096 : 240)) usage();
    seen.add(flag);
    if (flag === "--out") destination = value;
    else if (flag === "--model") options.model = value;
    else options.provider = value;
  }
  if (command === "resume") return { command, path, options };
  if (destination === undefined) usage();
  return { command, path, destination, options };
}

export async function runHarnessCommand(args: readonly string[]): Promise<unknown> {
  const parsed = parseArguments(args);
  const input = parsed.command === "run" ? captureDmHarnessInput(parsed.path, parsed.destination) : null;
  const resumedDirectory = parsed.command === "resume" ? resolveDmHarnessRunDirectory(parsed.path) : null;
  const { prepareDmHarnessRun, createDmHarnessSession, DmHarnessError } = await import("@wmm/application");
  const applicationCode = (error: unknown, fallback: string): string =>
    error instanceof DmHarnessError && /^[A-Z][A-Z_]{0,63}$/.test(error.code) ? `HARNESS_${error.code}` : fallback;
  const session = (() => {
    if (parsed.command === "resume") {
      try { return createDmHarnessSession(resumedDirectory!, { resume: true }); }
      catch (error) {
        throw new HarnessCommandError(applicationCode(error, "HARNESS_RESUME_ERROR"), "Unable to re-admit the retained DM harness run; no provider was started and previous artifacts were retained");
      }
    }
    let info;
    try { info = prepareDmHarnessRun(input, parsed.destination); }
    catch (error) {
      if (error instanceof DmHarnessError && error.code === "UNSUPPORTED_PROFILE") {
        throw new HarnessCommandError("HARNESS_UNSUPPORTED_PROFILE", "Economic-profile DM notes are unsupported; no declarations may be silently removed");
      }
      // Compiler/schema diagnostics may contain selected content. Keep those
      // host-side instead of reflecting project data into terminal errors.
      throw new HarnessInputError();
    }
    return createDmHarnessSession(info.runDirectory);
  })();
  const finalize = () => {
    try { return session.finalize(); }
    catch (error) {
      throw new HarnessCommandError(applicationCode(error, "HARNESS_FINALIZATION_ERROR"), "Unable to finalize the DRAFT; partial artifacts and the admitted proposal are retained for explicit resume into a fresh attempt");
    }
  };
  if (session.hasProposal()) return finalize();
  const { runDmHarnessAgent, HarnessRuntimeError } = await import("./harness-runtime.js");
  try { await runDmHarnessAgent(session, parsed.options); }
  catch (error) {
    if (error instanceof HarnessRuntimeError) throw new HarnessCommandError(error.code, error.message);
    throw new HarnessCommandError("HARNESS_RUNTIME_ERROR", "Unable to complete the isolated Hermes attempt; the captured run is retained for resume");
  }
  if (!session.hasProposal()) throw new HarnessCommandError("HARNESS_NO_PROPOSAL", "Hermes completed without an explicit admitted proposal; the run is retained for resume");
  return finalize();
}
