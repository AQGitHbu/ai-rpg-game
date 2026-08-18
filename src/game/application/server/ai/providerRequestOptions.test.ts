import { describe, expect, it } from "vitest";
import { createProviderRequestOptions } from "./providerRequestOptions";

describe("createProviderRequestOptions", () => {
  it("uses DeepSeek's official thinking.type switch to disable reasoning", () => {
    expect(createProviderRequestOptions(30_000)).toEqual({
      timeoutMs: 30_000,
      extraBody: { thinking: { type: "disabled" } },
    });
  });

  it("adds a bounded low-temperature completion budget for small runtime JSON", () => {
    expect(createProviderRequestOptions(30_000, 800)).toEqual({
      timeoutMs: 30_000,
      temperature: 0.2,
      extraBody: {
        thinking: { type: "disabled" },
        max_tokens: 800,
      },
    });
  });

  it("enables JSON object mode only when explicitly selected", () => {
    expect(createProviderRequestOptions(30_000, 800, "json_object")).toEqual({
      timeoutMs: 30_000,
      temperature: 0.2,
      extraBody: {
        thinking: { type: "disabled" },
        max_tokens: 800,
        response_format: { type: "json_object" },
      },
    });
  });

  it("keeps JSON object mode for unbounded opening generation", () => {
    expect(createProviderRequestOptions(240_000, undefined, "json_object")).toEqual({
      timeoutMs: 240_000,
      extraBody: {
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
      },
    });
  });
});
