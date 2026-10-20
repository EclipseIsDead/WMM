import { readSync } from "node:fs";

import { printParseErrorCode, visit } from "jsonc-parser";

export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_JSON_DEPTH = 128;
export const MAX_JSON_NODES = 100_000;
const READ_CHUNK_BYTES = 64 * 1024;

class RequestParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestParseError";
  }
}

export function readJsonInput(fd = 0): Uint8Array {
  // The extra byte distinguishes an exactly-at-limit request from an oversized
  // one without consuming the rest of an untrusted (possibly still open) pipe.
  const buffer = Buffer.allocUnsafe(MAX_REQUEST_BYTES + 1);
  let length = 0;
  while (length < buffer.length) {
    const count = readSync(
      fd,
      buffer,
      length,
      Math.min(READ_CHUNK_BYTES, buffer.length - length),
      null,
    );
    if (count === 0) break;
    length += count;
  }
  return buffer.subarray(0, length);
}

export function parseStrictJson(text: string): unknown {
  const objectKeys: Set<string>[] = [];
  let depth = 0;
  let nodes = 0;

  function countNode(): void {
    // Count property names as well as values, bounding wide objects too.
    nodes += 1;
    if (nodes > MAX_JSON_NODES) {
      throw new RequestParseError(`JSON request exceeds the ${MAX_JSON_NODES}-node parsing limit`);
    }
  }

  function beginContainer(): void {
    countNode();
    depth += 1;
    if (depth > MAX_JSON_DEPTH) {
      throw new RequestParseError(`JSON request exceeds the ${MAX_JSON_DEPTH}-level nesting limit`);
    }
  }

  function checkString(value: string): void {
    if (!value.isWellFormed()) {
      throw new RequestParseError("JSON strings must contain only Unicode scalar values");
    }
  }

  visit(
    text,
    {
      onObjectBegin: () => {
        beginContainer();
        objectKeys.push(new Set());
      },
      onObjectProperty: (property) => {
        countNode();
        checkString(property);
        const keys = objectKeys.at(-1);
        if (keys?.has(property) === true) {
          throw new RequestParseError(`Duplicate JSON object key: ${property}`);
        }
        keys?.add(property);
      },
      onObjectEnd: () => {
        objectKeys.pop();
        depth -= 1;
      },
      onArrayBegin: beginContainer,
      onArrayEnd: () => {
        depth -= 1;
      },
      onLiteralValue: (value) => {
        countNode();
        if (typeof value === "string") checkString(value);
      },
      onError: (error) => {
        throw new RequestParseError(`Invalid JSON: ${printParseErrorCode(error)}`);
      },
    },
    { allowTrailingComma: false, disallowComments: true },
  );

  // jsonc-parser's materializer assigns properties, so a __proto__ key can
  // mutate prototypes. Native JSON.parse preserves it as an ordinary own key
  // for the closed request schemas to reject.
  return JSON.parse(text) as unknown;
}
