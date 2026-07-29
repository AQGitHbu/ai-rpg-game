import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateNewGameInput, type NewGameInput } from "@/game/domain";
import type { ScenarioGenerationRequest } from "../../scenarioGeneration";
import {
  createFixtureScenarioCandidateSource
} from "./fixtureScenarioCandidateSource";

// ---------------------------------------------------------------------------
// fixture source 契约测试：使用临时 fixture 根目录，不读、不改 data/fixtures/phase4。
// ---------------------------------------------------------------------------

const NEW_GAME_INPUT: NewGameInput = {
  gameType: "wuxia",
  characterName: "沈青崖",
  characterIdentity: "落魄镖师",
  characterProfile: "青崖镖局独子，镖局一夜覆灭后流落江湖，靠押送散货为生。",
  personalityTags: ["坚毅", "重情义"],
  worldPremise: "镖局一夜覆灭，江湖各派暗流涌动，真凶身份成谜，官府与门派各怀心思。",
  storyOpening: "暮色四合，主角背着旧刀走进青石镇，镇口贴着一张字迹潦草的缉凶告示。",
  narrativeStyle: "novel",
  contentIntensity: "normal"
};

function buildRequest(): ScenarioGenerationRequest {
  const validated = validateNewGameInput(NEW_GAME_INPUT);
  if (!validated.ok) throw new Error("测试输入必须合法");
  return { input: validated.value, seed: "phase1-wuxia-001", traceId: "trace-test-0001" };
}

/** 最小合法结构候选：source 只做结构存在性检查，不做完整业务校验。 */
const MINIMAL_CANDIDATE = {
  schemaVersion: 1,
  generationId: "gen-test",
  seed: "phase1-wuxia-001",
  templateVersion: "fallback-3",
  gameType: "wuxia",
  inputDigest: "digest-test",
  world: { summary: "s", tone: "t", themes: [], facts: [], tags: [] },
  player: {
    name: "沈青崖",
    identity: "落魄镖师",
    backgroundSummary: "b",
    startingLocationId: "loc_1",
    startingItemIds: [],
    baseStats: { hp: 30, attack: 6, defense: 4 }
  },
  locations: [],
  npcs: [],
  quests: [],
  enemies: [],
  items: [],
  endings: [],
  openingScene: {
    id: "scene_opening",
    locationId: "loc_1",
    narration: "n",
    presentNpcIds: [],
    suggestedActions: [],
    investigableFactIds: []
  },
  contentBudget: {
    mainLocations: 4,
    hiddenLocationsMax: 1,
    coreNpcsMin: 4,
    coreNpcsMax: 6,
    companionsMax: 1,
    sideQuestsMax: 2,
    endings: 2
  }
};

const MANIFEST = {
  contractVersion: "phase4b-v1",
  fixtures: [
    { id: "generated-wuxia", file: "generated-wuxia.json", gameType: "wuxia", seed: "phase1-wuxia-001" },
    { id: "timeout", file: "timeout.json", gameType: "wuxia", seed: "phase1-wuxia-001" },
    { id: "invalid-json", file: "invalid-json.json", gameType: "wuxia", seed: "phase1-wuxia-001" },
    { id: "missing-file", file: "missing-file.json", gameType: "wuxia", seed: "phase1-wuxia-001" },
    { id: "escape", file: "../escape.json", gameType: "wuxia", seed: "phase1-wuxia-001" },
    { id: "broken-root", file: "broken-root.json", gameType: "wuxia", seed: "phase1-wuxia-001" }
  ]
};

let fixtureRoot: string;

beforeEach(async () => {
  fixtureRoot = await mkdtemp(path.join(tmpdir(), "phase4a-source-"));
  const write = (file: string, payload: unknown) =>
    writeFile(path.join(fixtureRoot, file), JSON.stringify(payload, null, 2), "utf8");
  await write("manifest.json", MANIFEST);
  await write("generated-wuxia.json", { candidate: MINIMAL_CANDIDATE });
  await write("timeout.json", { failureMode: "timeout", diagnostics: ["FIXTURE_TIMEOUT"] });
  await write("invalid-json.json", { responseText: "{not-json" });
  await write("broken-root.json", { candidate: { ...MINIMAL_CANDIDATE, npcs: "oops" } });
});

afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe("createFixtureScenarioCandidateSource", () => {
  it("合法候选 fixture 返回 ok attempt", async () => {
    const source = createFixtureScenarioCandidateSource({ fixtureRoot, fixtureId: "generated-wuxia" });
    const attempt = await source.generate(buildRequest());
    expect(attempt).toMatchObject({
      ok: true,
      contractVersion: "phase4b-v1",
      origin: "fixture"
    });
    if (attempt.ok) {
      expect(attempt.candidate.generationId).toBe("gen-test");
      expect(attempt.diagnostics).toEqual([]);
    }
  });

  it("timeout 故障 fixture 映射 timeout 类别与稳定诊断码", async () => {
    const source = createFixtureScenarioCandidateSource({ fixtureRoot, fixtureId: "timeout" });
    expect(await source.generate(buildRequest())).toMatchObject({
      ok: false,
      origin: "fixture",
      category: "timeout",
      diagnostics: ["FIXTURE_TIMEOUT"]
    });
  });

  it("responseText 不可解析映射 invalid_json", async () => {
    const source = createFixtureScenarioCandidateSource({ fixtureRoot, fixtureId: "invalid-json" });
    expect(await source.generate(buildRequest())).toMatchObject({
      ok: false,
      origin: "fixture",
      category: "invalid_json"
    });
  });

  it("未知 fixture ID 映射 service_error", async () => {
    const source = createFixtureScenarioCandidateSource({ fixtureRoot, fixtureId: "no-such-id" });
    const attempt = await source.generate(buildRequest());
    expect(attempt).toMatchObject({ ok: false, origin: "fixture", category: "service_error" });
    if (!attempt.ok) expect(attempt.diagnostics).toEqual(["FIXTURE_ID_UNKNOWN"]);
  });

  it("fixture 文件缺失映射 service_error", async () => {
    const source = createFixtureScenarioCandidateSource({ fixtureRoot, fixtureId: "missing-file" });
    const attempt = await source.generate(buildRequest());
    expect(attempt).toMatchObject({ ok: false, category: "service_error" });
    if (!attempt.ok) expect(attempt.diagnostics).toEqual(["FIXTURE_FILE_UNREADABLE"]);
  });

  it("manifest file 路径逃逸被拒绝并映射 service_error", async () => {
    const source = createFixtureScenarioCandidateSource({ fixtureRoot, fixtureId: "escape" });
    const attempt = await source.generate(buildRequest());
    expect(attempt).toMatchObject({ ok: false, category: "service_error" });
    if (!attempt.ok) expect(attempt.diagnostics).toEqual(["FIXTURE_PATH_ESCAPE"]);
  });

  it("manifest 契约版本不符映射 service_error", async () => {
    await writeFile(
      path.join(fixtureRoot, "manifest.json"),
      JSON.stringify({ ...MANIFEST, contractVersion: "phase9z-v9" }),
      "utf8"
    );
    const source = createFixtureScenarioCandidateSource({ fixtureRoot, fixtureId: "generated-wuxia" });
    const attempt = await source.generate(buildRequest());
    expect(attempt).toMatchObject({ ok: false, category: "service_error" });
    if (!attempt.ok) expect(attempt.diagnostics).toEqual(["FIXTURE_MANIFEST_CONTRACT_MISMATCH"]);
  });

  it("候选根结构不完整映射 schema_violation", async () => {
    const source = createFixtureScenarioCandidateSource({ fixtureRoot, fixtureId: "broken-root" });
    const attempt = await source.generate(buildRequest());
    expect(attempt).toMatchObject({ ok: false, origin: "fixture", category: "schema_violation" });
  });
});
