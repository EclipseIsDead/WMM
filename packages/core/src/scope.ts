import type {
  ScopeComparisonV1,
  ScopeComparisonValue,
  ScopeV1,
  ScopeValueV1,
} from "@wmm/wire-contracts";

export function compareScopeValue(
  left: ScopeValueV1,
  right: ScopeValueV1,
): ScopeComparisonValue {
  if (left.kind === "unresolved" || right.kind === "unresolved") return "unresolved";
  if (left.kind !== right.kind) return "different";
  if (left.kind === "notApplicable") return "same";
  if (right.kind !== "ref") return "different";
  return left.id === right.id ? "same" : "different";
}

export function compareScope(left: ScopeV1, right: ScopeV1): ScopeComparisonV1 {
  const components = {
    account: compareScopeValue(left.account, right.account),
    jurisdiction: compareScopeValue(left.jurisdiction, right.jurisdiction),
    recognitionFrame: compareScopeValue(
      left.recognitionFrame,
      right.recognitionFrame,
    ),
  } as const;

  const values = Object.values(components);
  const result: ScopeComparisonValue = values.includes("different")
    ? "different"
    : values.includes("unresolved")
      ? "unresolved"
      : "same";

  return {
    format: "wmm.scope-comparison/1",
    result,
    components,
  };
}
