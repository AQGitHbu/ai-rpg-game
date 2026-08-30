import { describe, expect, it } from "vitest";
import { buildEntityContextProjection } from "./entityContextProjection";

describe("buildEntityContextProjection", () => {
  it("is exported as the store-backed, privacy-safe context boundary", () => {
    expect(typeof buildEntityContextProjection).toBe("function");
  });
});
