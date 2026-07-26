import { describe, expect, it } from "vitest";
import type { GameTypeId } from "@/game/domain";
import {
  loadScenarioProfiles,
  ScenarioConfigError,
  type RawScenarioConfig,
  type ScenarioConfigIssue
} from "./gameTypeProfiles";

const GAME_TYPE_IDS: readonly GameTypeId[] = [
  "wuxia", "xianxia", "fantasy", "science_fiction",
  "urban", "alternate_history", "post_apocalypse"
];

type MutableRecord = Record<string, Record<string, unknown>>;

function makeArtStyles(): MutableRecord {
  return Object.fromEntries(
    GAME_TYPE_IDS.map((id) => [
      `style_${id}`,
      {
        id: `style_${id}`,
        promptPrefix: `${id} 风格前缀`,
        palette: "测试色板",
        texture: "测试质感",
        composition: "测试构图",
        negativePrompt: "测试负面提示"
      }
    ])
  );
}

function makeGameTypes(): MutableRecord {
  return Object.fromEntries(
    GAME_TYPE_IDS.map((id) => [
      id,
      {
        id,
        label: `${id} 标签`,
        worldConstraints: [`${id} 约束一`, `${id} 约束二`, `${id} 约束三`],
        allowedTags: [`${id} 标签一`, `${id} 标签二`, `${id} 标签三`, `${id} 标签四`, `${id} 标签五`],
        forbiddenTags: [`${id} 禁一`, `${id} 禁二`, `${id} 禁三`],
        namingGuide: [`${id} 命名一`, `${id} 命名二`, `${id} 命名三`],
        artStyleProfileId: `style_${id}`
      }
    ])
  );
}

function makeRaw(): RawScenarioConfig & { gameTypeProfiles: MutableRecord; artStyleProfiles: MutableRecord } {
  return { gameTypeProfiles: makeGameTypes(), artStyleProfiles: makeArtStyles() };
}

function loadIssues(raw: RawScenarioConfig): readonly ScenarioConfigIssue[] {
  try {
    loadScenarioProfiles(raw);
  } catch (error) {
    if (error instanceof ScenarioConfigError) return error.issues;
    throw error;
  }
  return [];
}

describe("loadScenarioProfiles / injected raw config", () => {
  it("accepts a fully valid config", () => {
    const result = loadScenarioProfiles(makeRaw());
    expect(Object.keys(result.gameTypeProfiles).sort()).toEqual([...GAME_TYPE_IDS].sort());
    expect(result.gameTypeProfiles.wuxia.artStyleProfileId).toBe("style_wuxia");
  });

  it("rejects a missing game type id", () => {
    const raw = makeRaw();
    delete raw.gameTypeProfiles.urban;
    expect(loadIssues(raw)).toContainEqual({
      path: "gameTypeProfiles",
      code: "MISSING_GAME_TYPE",
      params: { id: "urban" }
    });
  });

  it("rejects an unknown game type key", () => {
    const raw = makeRaw();
    raw.gameTypeProfiles.cthulhu = { ...raw.gameTypeProfiles.wuxia, id: "cthulhu" };
    expect(loadIssues(raw)).toContainEqual({
      path: "gameTypeProfiles.cthulhu",
      code: "UNKNOWN_GAME_TYPE",
      params: { key: "cthulhu" }
    });
  });

  it("rejects a profile whose id does not match its object key", () => {
    const raw = makeRaw();
    raw.gameTypeProfiles.wuxia.id = "xianxia";
    expect(loadIssues(raw)).toContainEqual({
      path: "gameTypeProfiles.wuxia.id",
      code: "ID_KEY_MISMATCH",
      params: { key: "wuxia", id: "xianxia" }
    });
  });

  it("rejects an artStyleProfileId referencing a nonexistent art style", () => {
    const raw = makeRaw();
    raw.gameTypeProfiles.fantasy.artStyleProfileId = "style_missing";
    expect(loadIssues(raw)).toContainEqual({
      path: "gameTypeProfiles.fantasy.artStyleProfileId",
      code: "UNKNOWN_ART_STYLE",
      params: { artStyleProfileId: "style_missing" }
    });
  });

  it("rejects a blank entry inside a list field", () => {
    const raw = makeRaw();
    (raw.gameTypeProfiles.wuxia.worldConstraints as string[])[1] = "   ";
    expect(loadIssues(raw)).toContainEqual({
      path: "gameTypeProfiles.wuxia.worldConstraints[1]",
      code: "BLANK_ENTRY",
      params: { index: 1 }
    });
  });

  it("rejects duplicate entries inside a list field", () => {
    const raw = makeRaw();
    (raw.gameTypeProfiles.urban.allowedTags as string[])[4] = "urban 标签一";
    expect(loadIssues(raw)).toContainEqual({
      path: "gameTypeProfiles.urban.allowedTags",
      code: "DUPLICATE_ENTRY",
      params: { value: "urban 标签一" }
    });
  });

  it("rejects an empty list field", () => {
    const raw = makeRaw();
    raw.gameTypeProfiles.xianxia.namingGuide = [];
    expect(loadIssues(raw)).toContainEqual({
      path: "gameTypeProfiles.xianxia.namingGuide",
      code: "EMPTY_LIST",
      params: {}
    });
  });

  it("rejects a blank label", () => {
    const raw = makeRaw();
    raw.gameTypeProfiles.post_apocalypse.label = "  ";
    expect(loadIssues(raw)).toContainEqual({
      path: "gameTypeProfiles.post_apocalypse.label",
      code: "REQUIRED",
      params: {}
    });
  });

  it("rejects non-string entries inside a list field", () => {
    const raw = makeRaw();
    (raw.gameTypeProfiles.fantasy.forbiddenTags as unknown[])[0] = 42;
    expect(loadIssues(raw)).toContainEqual({
      path: "gameTypeProfiles.fantasy.forbiddenTags[0]",
      code: "INVALID_TYPE",
      params: { expected: "string" }
    });
  });

  it("rejects an art style whose id does not match its object key", () => {
    const raw = makeRaw();
    raw.artStyleProfiles.style_wuxia.id = "style_other";
    expect(loadIssues(raw)).toContainEqual({
      path: "artStyleProfiles.style_wuxia.id",
      code: "ID_KEY_MISMATCH",
      params: { key: "style_wuxia", id: "style_other" }
    });
  });

  it("rejects a blank art style text field", () => {
    const raw = makeRaw();
    raw.artStyleProfiles.style_urban.negativePrompt = "";
    expect(loadIssues(raw)).toContainEqual({
      path: "artStyleProfiles.style_urban.negativePrompt",
      code: "REQUIRED",
      params: {}
    });
  });

  it("collects all issues in a single throw", () => {
    const raw = makeRaw();
    delete raw.gameTypeProfiles.urban;
    raw.gameTypeProfiles.wuxia.id = "xianxia";
    raw.gameTypeProfiles.fantasy.artStyleProfileId = "style_missing";
    const issues = loadIssues(raw);
    expect(issues.map((issue) => issue.code).sort()).toEqual(
      ["ID_KEY_MISMATCH", "MISSING_GAME_TYPE", "UNKNOWN_ART_STYLE"].sort()
    );
  });

  it("throws a ScenarioConfigError carrying structured issues", () => {
    const raw = makeRaw();
    delete raw.gameTypeProfiles.wuxia;
    let caught: unknown;
    try {
      loadScenarioProfiles(raw);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ScenarioConfigError);
    expect((caught as ScenarioConfigError).issues.length).toBeGreaterThan(0);
    expect((caught as ScenarioConfigError).name).toBe("ScenarioConfigError");
  });

  it("rejects non-object profile containers", () => {
    const issues = loadIssues({ gameTypeProfiles: [], artStyleProfiles: null });
    expect(issues).toContainEqual({
      path: "gameTypeProfiles",
      code: "INVALID_TYPE",
      params: { expected: "object" }
    });
    expect(issues).toContainEqual({
      path: "artStyleProfiles",
      code: "INVALID_TYPE",
      params: { expected: "object" }
    });
  });
});

describe("loadScenarioProfiles / real JSON config", () => {
  it("passes validation and exposes all seven profiles", () => {
    const result = loadScenarioProfiles();
    expect(Object.keys(result.gameTypeProfiles).sort()).toEqual([...GAME_TYPE_IDS].sort());
    for (const id of GAME_TYPE_IDS) {
      const profile = result.gameTypeProfiles[id];
      expect(profile.id).toBe(id);
      expect(result.artStyleProfiles[profile.artStyleProfileId]).toBeDefined();
    }
  });

  it("meets the minimum authored content thresholds", () => {
    const result = loadScenarioProfiles();
    for (const id of GAME_TYPE_IDS) {
      const profile = result.gameTypeProfiles[id];
      expect(profile.label.length, `${id}.label`).toBeGreaterThan(0);
      expect(profile.worldConstraints.length, `${id}.worldConstraints`).toBeGreaterThanOrEqual(3);
      expect(profile.allowedTags.length, `${id}.allowedTags`).toBeGreaterThanOrEqual(5);
      expect(profile.forbiddenTags.length, `${id}.forbiddenTags`).toBeGreaterThanOrEqual(3);
      expect(profile.namingGuide.length, `${id}.namingGuide`).toBeGreaterThanOrEqual(3);
    }
  });

  it("provides the required prompt fields for every art style", () => {
    const result = loadScenarioProfiles();
    for (const style of Object.values(result.artStyleProfiles)) {
      expect(style.promptPrefix.length).toBeGreaterThan(0);
      expect(style.palette.length).toBeGreaterThan(0);
      expect(style.texture.length).toBeGreaterThan(0);
      expect(style.composition.length).toBeGreaterThan(0);
      expect(style.negativePrompt.length).toBeGreaterThan(0);
    }
  });
});
