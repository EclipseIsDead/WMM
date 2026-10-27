import { economyBindingLines, economyCategories, economyCategoryLabels, economyRecordLines, economyRecordSummary } from "../economy-format.js";
import type { WorkspaceUiState } from "./controller.js";
import { fit, viewport, wrap } from "./text.js";

const prose = (lines: readonly string[], width: number): string[] => lines.flatMap(line => wrap(line, width));

/** Uses the same complete readable record formatter as the linear CLI. */
export function renderEconomyBody(state: WorkspaceUiState, height: number, width: number, columns: number, reportLimit?: (limit: number) => void): string[] {
  const current = state.economy;
  const result = current.view;
  const header = prose(["ECONOMY / DM / READ-ONLY", "BASE WORLD | Selected proposals excluded; candidate unavailable.", "Accounting/scenarios not run; no availability totals."], width);
  if (current.error || !result) return viewport([...header, ...prose(["ECONOMY UNAVAILABLE", current.error ?? "No Economy read supplied. o/Esc returns to World."], width)], state.scroll, height, width, reportLimit);
  const view = result.economy;
  const records = view.records.filter(record => record.value.kind === current.category);
  const index = Math.min(current.indices[current.category], Math.max(0, records.length - 1));
  const selected = records[index];
  const category = `${economyCategoryLabels[current.category]} | ${economyCategories.indexOf(current.category) + 1}/3 | [ ]: category`;
  const details = (paneWidth: number): string[] => state.raw
    ? prose(["RAW ECONOMY PAYLOAD", JSON.stringify(result, null, 2)], paneWidth)
    : [...(selected ? economyRecordLines(view, selected, paneWidth) : prose(["No records declared in this category."], paneWidth)), "", ...prose(["VIEW BINDINGS"], paneWidth), ...economyBindingLines(view, paneWidth), "", ...prose(["LIMITATIONS", ...result.limitations, ...view.limitations], paneWidth)];
  if (state.detail) return viewport(details(width), state.scroll, height, width, reportLimit);
  const list = (paneWidth: number, paneHeight: number): string[] => {
    const rows = records.map((record, row) => prose([`${row === index ? ">" : " "} ${economyRecordSummary(view, record)}`], paneWidth));
    const offset = Math.max(0, rows.slice(0, index).reduce((sum, lines) => sum + lines.length, 0) - Math.max(0, paneHeight - (rows[index]?.length ?? 0) - 2));
    return viewport([...rows.flat(), ...(records.length ? [] : ["No records declared."]), "", ...prose(["Enter: inspect | j/k: rows"], paneWidth)], offset, paneHeight, paneWidth);
  };
  const heading = [...header, ...prose([category], width), ""];
  const remaining = Math.max(1, height - heading.length);
  if (columns < 100) return [...heading, ...list(width, remaining)].slice(0, height);
  const leftWidth = Math.floor((width - 3) * 0.4), rightWidth = width - leftWidth - 3;
  const left = list(leftWidth, remaining);
  const right = viewport([...prose([state.inspectorFocus ? "INSPECTOR (Left: list)" : "INSPECTOR (Right: scroll)"], rightWidth), ...details(rightWidth)], state.scroll, remaining, rightWidth, reportLimit);
  return [...heading, ...Array.from({ length: remaining }, (_, row) => `${fit(left[row] ?? "", leftWidth)} | ${fit(right[row] ?? "", rightWidth)}`)].slice(0, height);
}
