import { describe, expect, it } from "vitest";
import { diffRecords } from "./diff";

describe("diffRecords", () => {
  it("reports changed fields with from/to", () => {
    expect(diffRecords({ a: 1, b: "x" }, { a: 2, b: "x" })).toEqual({ a: { from: 1, to: 2 } });
  });
  it("ignores bookkeeping columns and array order", () => {
    expect(diffRecords({ tags: ["a", "b"], updatedAt: new Date(0) }, { tags: ["b", "a"], updatedAt: new Date() })).toEqual({});
  });
  it("handles null previous", () => {
    expect(diffRecords(null, { a: 1 })).toEqual({ a: { from: null, to: 1 } });
  });
});
