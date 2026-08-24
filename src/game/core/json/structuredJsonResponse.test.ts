import { describe, expect, it } from "vitest";
import { parseStructuredJsonObject } from "@/game/core/json";

describe("parseStructuredJsonObject", () => {
  it("accepts a JSON object without normalization", () => {
    expect(parseStructuredJsonObject('{"ok":true}')).toEqual({
      ok: true,
      value: { ok: true },
      normalization: "none",
    });
  });

  it("unwraps a fenced JSON object", () => {
    expect(parseStructuredJsonObject("```json\n{\"ok\":true}\n```")).toEqual({
      ok: true,
      value: { ok: true },
      normalization: "json_fence",
    });
  });

  it("rejects surrounding prose instead of extracting a JSON substring", () => {
    expect(parseStructuredJsonObject('before {"ok":true} after')).toEqual({
      ok: false,
      reason: "invalid_json",
    });
  });

  it("rejects non-object JSON roots", () => {
    expect(parseStructuredJsonObject("[]")).toEqual({
      ok: false,
      reason: "root_not_object",
    });
  });
});
