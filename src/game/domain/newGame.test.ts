import { describe, expect, it } from "vitest";
import {
  validateNewGameInput,
  type GameTypeId,
  type NarrativeStyle,
  type ContentIntensity,
  type NewGameInput,
  type NewGameInputError,
  type ValidatedNewGameInput
} from "./newGame";

function baseInput(): NewGameInput {
  return {
    gameType: "wuxia",
    characterName: "林惊羽",
    characterIdentity: "青云门外门弟子",
    characterProfile: "自幼习剑，性情坚毅。",
    personalityTags: ["坚毅", "寡言"],
    worldPremise: "字".repeat(20),
    storyOpening: "字".repeat(20),
    narrativeStyle: "concise",
    contentIntensity: "normal"
  };
}

function expectOk(input: NewGameInput): ValidatedNewGameInput {
  const result = validateNewGameInput(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected ok result");
  return result.value;
}

function expectErrors(input: NewGameInput): NewGameInputError[] {
  const result = validateNewGameInput(input);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected error result");
  return result.errors;
}

describe("validateNewGameInput", () => {
  it("accepts a valid input and returns the normalized value", () => {
    const value = expectOk(baseInput());
    expect(value.characterName).toBe("林惊羽");
    expect(value.personalityTags).toEqual(["坚毅", "寡言"]);
  });

  describe("characterName (2–20)", () => {
    it("accepts the minimum length of 2", () => {
      expectOk({ ...baseInput(), characterName: "阿三" });
    });

    it("accepts the maximum length of 20", () => {
      expectOk({ ...baseInput(), characterName: "名".repeat(20) });
    });

    it("rejects a blank name as REQUIRED", () => {
      const errors = expectErrors({ ...baseInput(), characterName: "   " });
      expect(errors).toContainEqual({ field: "characterName", code: "REQUIRED", params: {} });
    });

    it("rejects 1 character as TOO_SHORT", () => {
      const errors = expectErrors({ ...baseInput(), characterName: "一" });
      expect(errors).toContainEqual({
        field: "characterName",
        code: "TOO_SHORT",
        params: { min: 2, actual: 1 }
      });
    });

    it("rejects 21 characters as TOO_LONG", () => {
      const errors = expectErrors({ ...baseInput(), characterName: "名".repeat(21) });
      expect(errors).toContainEqual({
        field: "characterName",
        code: "TOO_LONG",
        params: { max: 20, actual: 21 }
      });
    });
  });

  describe("characterIdentity (2–80)", () => {
    it("accepts lengths 2 and 80", () => {
      expectOk({ ...baseInput(), characterIdentity: "刀客" });
      expectOk({ ...baseInput(), characterIdentity: "职".repeat(80) });
    });

    it("rejects a blank identity as REQUIRED", () => {
      const errors = expectErrors({ ...baseInput(), characterIdentity: " " });
      expect(errors).toContainEqual({ field: "characterIdentity", code: "REQUIRED", params: {} });
    });

    it("rejects 1 character as TOO_SHORT and 81 as TOO_LONG", () => {
      expect(expectErrors({ ...baseInput(), characterIdentity: "刀" })).toContainEqual({
        field: "characterIdentity",
        code: "TOO_SHORT",
        params: { min: 2, actual: 1 }
      });
      expect(expectErrors({ ...baseInput(), characterIdentity: "职".repeat(81) })).toContainEqual({
        field: "characterIdentity",
        code: "TOO_LONG",
        params: { max: 80, actual: 81 }
      });
    });
  });

  describe("characterProfile (optional, max 300)", () => {
    it("accepts undefined", () => {
      const value = expectOk({ ...baseInput(), characterProfile: undefined });
      expect(value.characterProfile).toBeUndefined();
    });

    it("normalizes a whitespace-only profile to undefined", () => {
      const value = expectOk({ ...baseInput(), characterProfile: "   " });
      expect(value.characterProfile).toBeUndefined();
    });

    it("accepts exactly 300 characters", () => {
      expectOk({ ...baseInput(), characterProfile: "述".repeat(300) });
    });

    it("rejects 301 characters as TOO_LONG", () => {
      const errors = expectErrors({ ...baseInput(), characterProfile: "述".repeat(301) });
      expect(errors).toContainEqual({
        field: "characterProfile",
        code: "TOO_LONG",
        params: { max: 300, actual: 301 }
      });
    });
  });

  describe("worldPremise (20–500)", () => {
    it("accepts lengths 20 and 500", () => {
      expectOk({ ...baseInput(), worldPremise: "界".repeat(20) });
      expectOk({ ...baseInput(), worldPremise: "界".repeat(500) });
    });

    it("rejects a blank premise as REQUIRED", () => {
      const errors = expectErrors({ ...baseInput(), worldPremise: "  " });
      expect(errors).toContainEqual({ field: "worldPremise", code: "REQUIRED", params: {} });
    });

    it("rejects 19 as TOO_SHORT and 501 as TOO_LONG", () => {
      expect(expectErrors({ ...baseInput(), worldPremise: "界".repeat(19) })).toContainEqual({
        field: "worldPremise",
        code: "TOO_SHORT",
        params: { min: 20, actual: 19 }
      });
      expect(expectErrors({ ...baseInput(), worldPremise: "界".repeat(501) })).toContainEqual({
        field: "worldPremise",
        code: "TOO_LONG",
        params: { max: 500, actual: 501 }
      });
    });
  });

  describe("storyOpening (20–300)", () => {
    it("accepts lengths 20 and 300", () => {
      expectOk({ ...baseInput(), storyOpening: "章".repeat(20) });
      expectOk({ ...baseInput(), storyOpening: "章".repeat(300) });
    });

    it("rejects a blank opening as REQUIRED", () => {
      const errors = expectErrors({ ...baseInput(), storyOpening: "" });
      expect(errors).toContainEqual({ field: "storyOpening", code: "REQUIRED", params: {} });
    });

    it("rejects 19 as TOO_SHORT and 301 as TOO_LONG", () => {
      expect(expectErrors({ ...baseInput(), storyOpening: "章".repeat(19) })).toContainEqual({
        field: "storyOpening",
        code: "TOO_SHORT",
        params: { min: 20, actual: 19 }
      });
      expect(expectErrors({ ...baseInput(), storyOpening: "章".repeat(301) })).toContainEqual({
        field: "storyOpening",
        code: "TOO_LONG",
        params: { max: 300, actual: 301 }
      });
    });
  });

  describe("personalityTags (0–3, deduplicated)", () => {
    it("accepts an empty tag list", () => {
      const value = expectOk({ ...baseInput(), personalityTags: [] });
      expect(value.personalityTags).toEqual([]);
    });

    it("accepts 3 distinct tags and trims each", () => {
      const value = expectOk({ ...baseInput(), personalityTags: [" 果断 ", "冷静", "多疑"] });
      expect(value.personalityTags).toEqual(["果断", "冷静", "多疑"]);
    });

    it("rejects a blank tag as BLANK with its index", () => {
      const errors = expectErrors({ ...baseInput(), personalityTags: ["果断", "  "] });
      expect(errors).toContainEqual({
        field: "personalityTags",
        code: "BLANK",
        params: { index: 1 }
      });
    });

    it("rejects duplicated tags as DUPLICATE_TAG", () => {
      const errors = expectErrors({ ...baseInput(), personalityTags: ["果断", "果断"] });
      expect(errors).toContainEqual({
        field: "personalityTags",
        code: "DUPLICATE_TAG",
        params: { tag: "果断" }
      });
    });

    it("detects duplicates after trimming", () => {
      const errors = expectErrors({ ...baseInput(), personalityTags: [" 果断", "果断 "] });
      expect(errors).toContainEqual({
        field: "personalityTags",
        code: "DUPLICATE_TAG",
        params: { tag: "果断" }
      });
    });

    it("rejects more than 3 distinct tags as TOO_MANY_TAGS", () => {
      const errors = expectErrors({
        ...baseInput(),
        personalityTags: ["果断", "冷静", "多疑", "急躁"]
      });
      expect(errors).toContainEqual({
        field: "personalityTags",
        code: "TOO_MANY_TAGS",
        params: { max: 3, actual: 4 }
      });
    });

    it("counts the tag limit after deduplication and reports both problems", () => {
      const errors = expectErrors({
        ...baseInput(),
        personalityTags: ["果断", "冷静", "多疑", "急躁", "急躁"]
      });
      expect(errors).toContainEqual({
        field: "personalityTags",
        code: "DUPLICATE_TAG",
        params: { tag: "急躁" }
      });
      expect(errors).toContainEqual({
        field: "personalityTags",
        code: "TOO_MANY_TAGS",
        params: { max: 3, actual: 4 }
      });
    });
  });

  describe("enum fields", () => {
    it("rejects an unknown gameType", () => {
      const errors = expectErrors({ ...baseInput(), gameType: "space_opera" as GameTypeId });
      expect(errors).toContainEqual({
        field: "gameType",
        code: "INVALID_ENUM",
        params: { value: "space_opera" }
      });
    });

    it("rejects an unknown narrativeStyle", () => {
      const errors = expectErrors({
        ...baseInput(),
        narrativeStyle: "poetic" as NarrativeStyle
      });
      expect(errors).toContainEqual({
        field: "narrativeStyle",
        code: "INVALID_ENUM",
        params: { value: "poetic" }
      });
    });

    it("rejects an unknown contentIntensity", () => {
      const errors = expectErrors({
        ...baseInput(),
        contentIntensity: "brutal" as ContentIntensity
      });
      expect(errors).toContainEqual({
        field: "contentIntensity",
        code: "INVALID_ENUM",
        params: { value: "brutal" }
      });
    });
  });

  describe("normalization and determinism", () => {
    it("trims every text field before validating length", () => {
      const value = expectOk({
        ...baseInput(),
        characterName: "  林惊羽  ",
        characterIdentity: " 青云门外门弟子 ",
        characterProfile: " 自幼习剑。 ",
        worldPremise: `  ${"字".repeat(20)}  `,
        storyOpening: `\n${"字".repeat(20)}\n`
      });
      expect(value.characterName).toBe("林惊羽");
      expect(value.characterIdentity).toBe("青云门外门弟子");
      expect(value.characterProfile).toBe("自幼习剑。");
      expect(value.worldPremise).toBe("字".repeat(20));
      expect(value.storyOpening).toBe("字".repeat(20));
    });

    it("counts Unicode code points, not UTF-16 units", () => {
      // 20 emoji = 40 UTF-16 units but exactly 20 code points → valid.
      const name = "😀".repeat(20);
      expect(name.length).toBe(40);
      expectOk({ ...baseInput(), characterName: name });

      const errors = expectErrors({ ...baseInput(), characterName: "😀".repeat(21) });
      expect(errors).toContainEqual({
        field: "characterName",
        code: "TOO_LONG",
        params: { max: 20, actual: 21 }
      });
    });

    it("collects all errors in a single pass", () => {
      const errors = expectErrors({
        ...baseInput(),
        characterName: "一",
        characterIdentity: " ",
        worldPremise: "短",
        storyOpening: "短",
        personalityTags: ["重", "重"],
        gameType: "unknown" as GameTypeId
      });
      const fields = errors.map((error) => error.field);
      expect(fields).toContain("characterName");
      expect(fields).toContain("characterIdentity");
      expect(fields).toContain("worldPremise");
      expect(fields).toContain("storyOpening");
      expect(fields).toContain("personalityTags");
      expect(fields).toContain("gameType");
    });

    it("never mutates the original input", () => {
      const input = baseInput();
      input.characterName = "  林惊羽  ";
      Object.freeze(input.personalityTags);
      Object.freeze(input);

      const value = expectOk(input);
      expect(input.characterName).toBe("  林惊羽  ");
      expect(input.personalityTags).toEqual(["坚毅", "寡言"]);
      expect(value.personalityTags).not.toBe(input.personalityTags);
    });

    it("brands the validated value as a distinct type", () => {
      const raw = baseInput();
      // @ts-expect-error raw NewGameInput is not assignable to ValidatedNewGameInput
      const invalid: ValidatedNewGameInput = raw;
      expect(invalid).toBe(raw);
    });
  });
});
