import { types as utilTypes } from "node:util";

export function isScalarUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Capture-free preflight: do not execute accessors or proxy traps during admission. */
export function jsonDataError(input: unknown): string | undefined {
  let nodes = 0;
  const ancestors = new Set<object>();

  function visit(value: unknown, depth: number): string | undefined {
    nodes += 1;
    if (nodes > 200_000 || depth > 128) return "JSON data exceeds its work or depth limit";
    if (value === null || typeof value === "boolean") return undefined;
    if (typeof value === "string") {
      return isScalarUnicode(value) ? undefined : "JSON strings must contain Unicode scalar values";
    }
    if (typeof value === "number") {
      return Number.isSafeInteger(value) ? undefined : "JSON numbers must be safe integers";
    }
    if (typeof value !== "object" || utilTypes.isProxy(value)) {
      return "Only plain JSON data is accepted";
    }
    if (ancestors.has(value)) return "Cyclic JSON data is not accepted";
    const array = Array.isArray(value);
    if (!array && Object.getPrototypeOf(value) !== Object.prototype) {
      return "JSON objects must have the ordinary object prototype";
    }
    ancestors.add(value);
    try {
      const keys = Reflect.ownKeys(value);
      for (const key of keys) {
        if (array && key === "length") continue;
        if (typeof key !== "string" || !isScalarUnicode(key)) return "Invalid JSON property name";
        if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) {
          return "Arrays may contain only indexed elements";
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          return "JSON properties must be enumerable data properties";
        }
        const error = visit(descriptor.value, depth + 1);
        if (error !== undefined) return error;
      }
      if (array && keys.length !== value.length + 1) return "Sparse arrays are not accepted";
      return undefined;
    } finally {
      ancestors.delete(value);
    }
  }

  return visit(input, 0);
}
