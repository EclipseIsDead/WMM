import type { AtlasCell, AtlasGrid } from "@wmm/core";
import type { Atlas } from "@wmm/wire-contracts";

export type AtlasColourMode = "none" | "ansi16" | "ansi256" | "truecolor";
export function detectAtlasColourMode(stream: { readonly write?: unknown; readonly isTTY?: boolean; getColorDepth?: (env: NodeJS.ProcessEnv) => number }, env: NodeJS.ProcessEnv): AtlasColourMode {
  if (!stream.isTTY || env["TERM"] === "dumb" || Object.hasOwn(env, "NO_COLOR") || Object.hasOwn(env, "NODE_DISABLE_COLORS") || env["FORCE_COLOR"] === "0") return "none";
  if (env["FORCE_COLOR"] !== undefined) return env["FORCE_COLOR"] === "3" ? "truecolor" : env["FORCE_COLOR"] === "2" ? "ansi256" : "ansi16";
  const depth = stream.getColorDepth?.(env) ?? (/^(truecolor|24bit)$/i.test(env["COLORTERM"] ?? "") ? 24 : /256color/.test(env["TERM"] ?? "") ? 8 : 4);
  return depth >= 24 ? "truecolor" : depth >= 8 ? "ansi256" : depth >= 4 ? "ansi16" : "none";
}
export interface AtlasInkStyle { readonly color?: string; readonly backgroundColor?: string; readonly bold?: boolean }
export interface AtlasShaderRun { readonly text: string; readonly style: AtlasInkStyle }
export interface AtlasPaint {
  readonly atlas: Atlas;
  readonly grid: AtlasGrid;
  readonly glyphs: readonly string[];
  readonly options: { readonly layer: "reference" | "physical"; readonly selectedFeatureId: string | null; readonly cursorCell?: readonly [number, number] };
  /** First grid row in the final, already-cropped plaintext screen. */
  readonly row: number;
}
const empty: AtlasInkStyle = Object.freeze({});
const truecolour = {
  land: { color: "#a4c58c", backgroundColor: "#19261e" },
  water: { color: "#83c4e8", backgroundColor: "#102b3b" },
  unmapped: { color: "#7e8997", backgroundColor: "#171d26" },
  mixed: { color: "#e7c17a", backgroundColor: "#352c1b" },
} satisfies Record<string, AtlasInkStyle>;
const basic = {
  land: { color: "green", backgroundColor: "black" },
  water: { color: "cyan", backgroundColor: "black" },
  unmapped: { color: "gray", backgroundColor: "black" },
  mixed: { color: "yellow", backgroundColor: "black" },
} satisfies Record<string, AtlasInkStyle>;
function surfaceStyle(cell: AtlasCell, mode: AtlasColourMode): AtlasInkStyle {
  const palette = mode === "ansi16" ? basic : truecolour;
  if (!cell.surfaces.length || cell.surfaces.includes("unmapped")) return palette.unmapped;
  if (cell.surfaces.length > 1) return palette.mixed;
  return cell.surfaces[0] === "land" ? palette.land : cell.surfaces[0] === "water" ? palette.water : empty;
}

const colours = ["#76cbbd", "#e4b970", "#b6a1e1", "#87bde9", "#e39eaa", "#b8ce87", "#9fb4ea", "#dda9d8"] as const;
const basicColours = ["cyan", "yellow", "magenta", "blueBright", "redBright", "greenBright", "blue", "magentaBright"] as const;
/** The place identity, not feature order/name or a purported owner, determines colour. */
function colourIndex(id: string): number {
  let hash = 2166136261;
  for (const part of id) hash = Math.imul(hash ^ part.codePointAt(0)!, 16777619) >>> 0;
  return hash % colours.length;
}
function tint(colour: string, amount: number): string {
  const base = [27, 34, 44];
  return "#" + base.map((value, i) => Math.round(value * (1 - amount) + Number.parseInt(colour.slice(1 + i * 2, 3 + i * 2), 16) * amount).toString(16).padStart(2, "0")).join("");
}
function onEdge(grid: AtlasGrid, x: number, y: number, id: string): boolean {
  return !grid.cells[y - 1]?.[x]?.featureIds.includes(id) || !grid.cells[y + 1]?.[x]?.featureIds.includes(id) ||
    !grid.cells[y]?.[x - 1]?.featureIds.includes(id) || !grid.cells[y]?.[x + 1]?.featureIds.includes(id);
}

/** A CPU cell shader over an existing semantic framebuffer, never geometry sampling.
 * Glyphs and hit references survive exactly; adjacent equal styles form one Ink run.
 */
export function shadeAtlasGrid(paint: AtlasPaint, mode: AtlasColourMode): { readonly rows: readonly (readonly AtlasShaderRun[])[] } {
  const styles = new Map(paint.atlas.features.map(feature => {
    const index = colourIndex(feature.entityId), color = mode === "ansi16" ? basicColours[index]! : colours[index]!;
    const backgroundColor = mode === "ansi16" ? "black" : tint(colours[index]!, 0.18);
    return [feature.id, { interior: { color, backgroundColor }, edge: { color, backgroundColor, bold: true },
      selected: { color: mode === "ansi16" ? "whiteBright" : "#ffffff", backgroundColor: mode === "ansi16" ? "blue" : tint(colours[index]!, 0.38), bold: true }, color }];
  }));
  const mixed: AtlasInkStyle = { ...(mode === "ansi16" ? basic.mixed : truecolour.mixed), bold: true };
  const cursor: AtlasInkStyle = { color: mode === "ansi16" ? "black" : "#ffffff", backgroundColor: mode === "ansi16" ? "white" : "#48647f", bold: true };
  const rows = paint.grid.cells.map((cells, y) => {
    if (mode === "none") return [{ text: paint.glyphs[y]!, style: empty }];
    const runs: { text: string; style: AtlasInkStyle }[] = [];
    for (let x = 0; x < cells.length; x += 1) {
      const cell = cells[x]!, glyph = paint.glyphs[y]![x]!;
      let style = surfaceStyle(cell, mode);
      const selected = paint.options.selectedFeatureId;
      if (paint.options.cursorCell?.[0] === x && paint.options.cursorCell[1] === y) style = cursor;
      else if (paint.options.layer === "reference") {
        const targets = new Set([...cell.featureIds, ...cell.anchorFeatureIds]);
        const feature = styles.get(cell.featureIds[0] ?? cell.anchorFeatureIds[0] ?? "");
        if (selected && cell.featureIds.includes(selected)) style = styles.get(selected)?.selected ?? style;
        else if (targets.size > 1) style = mixed;
        else if (feature && cell.featureIds.length) style = onEdge(paint.grid, x, y, cell.featureIds[0]!) ? feature.edge : feature.interior;
        else if (feature) style = { ...style, color: feature.color, bold: true }; // Anchor target only: keep physical background.
      }
      const last = runs[runs.length - 1];
      if (last?.style === style) last.text += glyph;
      else runs.push({ text: glyph, style });
    }
    return runs;
  });
  return { rows };
}

/** Apply styles only after sanitization/cropping. Source/inspector strings never
 * become ANSI and are not reinterpreted as geometry or trusted styling input.
 */
export function shadeAtlasScreen(screen: string, paint: AtlasPaint | undefined, mode: AtlasColourMode): readonly AtlasShaderRun[] {
  if (!paint || mode === "none") return [{ text: screen, style: empty }];
  const shaded = shadeAtlasGrid(paint, mode), lines = screen.split("\n");
  const runs: { text: string; style: AtlasInkStyle }[] = [];
  const append = (text: string, style: AtlasInkStyle): void => {
    if (!text) return;
    const last = runs[runs.length - 1];
    if (style === empty && last?.style === empty) last.text += text;
    else runs.push({ text, style });
  };
  for (let y = 0; y < lines.length; y += 1) {
    const local = y - paint.row, line = lines[y]!;
    // A stale/mismatched layout falls back to text instead of painting another pane.
    if (local >= 0 && local < shaded.rows.length && line.startsWith(paint.glyphs[local]!)) {
      for (const run of shaded.rows[local]!) append(run.text, run.style);
      append(line.slice(paint.grid.columns), empty);
    } else append(line, empty);
    if (y < lines.length - 1) append("\n", empty);
  }
  return runs;
}
