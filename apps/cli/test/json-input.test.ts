import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_JSON_DEPTH,
  MAX_JSON_NODES,
  MAX_REQUEST_BYTES,
  parseStrictJson,
  readJsonInput,
} from "../src/json-input.js";

const { read } = vi.hoisted(() => ({
  read: vi.fn<(fd: number, buffer: Buffer, offset: number, length: number, position: null) => number>(),
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  readSync: read,
}));

beforeEach(() => { read.mockReset(); });

describe("bounded JSON input reads", () => {
  it("stops at the first over-limit byte without an EOF read", () => {
    let consumed = 0;
    read.mockImplementation((_fd, buffer, offset, length) => {
      expect(buffer.length).toBe(MAX_REQUEST_BYTES + 1);
      expect(length).toBeLessThanOrEqual(64 * 1024);
      expect(consumed + length).toBeLessThanOrEqual(MAX_REQUEST_BYTES + 1);
      buffer.fill(0x20, offset, offset + length);
      consumed += length;
      return length;
    });

    const result = readJsonInput();
    expect(result.length).toBe(MAX_REQUEST_BYTES + 1);
    expect(consumed).toBe(MAX_REQUEST_BYTES + 1);
    expect(read.mock.calls.at(-1)?.[3]).toBe(1);
  });

  it("handles short reads and returns only initialized bytes", () => {
    read.mockImplementationOnce((_fd, buffer, offset) => {
      buffer.write("{}", offset, "utf8");
      return 2;
    });
    read.mockReturnValueOnce(0);
    expect(Buffer.from(readJsonInput(7)).toString("utf8")).toBe("{}");
    expect(read.mock.calls).toHaveLength(2);
    expect(read.mock.calls[1]?.[0]).toBe(7);
    expect(read.mock.calls[1]?.[2]).toBe(2);
  });

  it("propagates input I/O failures to the JSON-mode boundary", () => {
    read.mockImplementation(() => { throw new Error("read failed"); });
    expect(() => readJsonInput()).toThrow("read failed");
  });
});

describe("strict JSON parsing", () => {
  it("materializes __proto__ as an ordinary own property at every depth", () => {
    const value = parseStrictJson(
      '{"__proto__":{"requestId":"inherited"},"payload":{"__proto__":{"bundlePath":"inherited"}}}',
    ) as Record<string, unknown>;
    const payload = value["payload"] as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(payload)).toBe(Object.prototype);
    expect(Object.hasOwn(value, "__proto__")).toBe(true);
    expect(Object.hasOwn(payload, "__proto__")).toBe(true);
    expect(value["requestId"]).toBeUndefined();
    expect(payload["bundlePath"]).toBeUndefined();
  });

  it.each([
    "", "{} {}", "// comment\n{}", "/* comment */{}", '{"a":1,}', "[1,]",
    "{a:1}", '{"a":NaN}', '{"a":undefined}', '{"a":01}', '{"a":"\\uZZZZ"}',
  ])("rejects non-strict syntax: %s", (text) => {
    expect(() => parseStrictJson(text)).toThrow();
  });

  it.each([
    '{"a":1,"\\u0061":2}',
    '{"nested":[{"a":1,"a":2}]}',
    '{"__proto__":{},"__proto__":{}}',
  ])("rejects decoded duplicate property names: %s", (text) => {
    expect(() => parseStrictJson(text)).toThrow("Duplicate JSON object key");
  });

  it.each(['"\\ud800"', '"\\udfff"', '{"\\ud800":0}', '{"a":["\\ud800x"]}'])(
    "rejects non-scalar string values and property names: %s",
    (text) => {
      expect(() => parseStrictJson(text)).toThrow("Unicode scalar values");
    },
  );

  it("accepts paired escaped surrogates and literal supplementary characters", () => {
    expect(parseStrictJson('{"😀":"\\ud83d\\ude00"}')).toEqual({ "😀": "😀" });
  });

  it("accepts the depth boundary and aborts deeply nested input before stack exhaustion", () => {
    expect(() => parseStrictJson("[".repeat(MAX_JSON_DEPTH) + "]".repeat(MAX_JSON_DEPTH))).not.toThrow();
    expect(() => parseStrictJson("[".repeat(10_000) + "]".repeat(10_000))).toThrow("nesting limit");
  });

  it("bounds total nodes, including property names", () => {
    expect(() => parseStrictJson(`[${"0,".repeat(MAX_JSON_NODES - 2)}0]`)).not.toThrow();
    expect(() => parseStrictJson(`[${"0,".repeat(MAX_JSON_NODES - 1)}0]`)).toThrow("node parsing limit");
    const properties = Array.from({ length: MAX_JSON_NODES / 2 }, (_, index) => `"k${index}":0`);
    expect(() => parseStrictJson(`{${properties.join(",")}}`)).toThrow("node parsing limit");
  });
});
