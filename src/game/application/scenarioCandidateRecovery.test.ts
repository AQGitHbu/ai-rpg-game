import { describe, expect, it } from "vitest";
import { validateNewGameInput, type NewGameInput, type ScenarioBlueprintCandidate } from "@/game/domain";
import { createFallbackBlueprint, loadScenarioProfiles } from "@/game/gameplay/rpg/scenario";
import { repairScenarioCandidate } from "./scenarioCandidateRecovery";

// ---------------------------------------------------------------------------
// 机械修复 helper 契约：只删未知根字段 / trim 字符串 / 裁剪超预算列表尾部；
// 悬空引用、任务图、tag、数值、文本内容一律不可修复（返回 null）。
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

function buildValidCandidate(): ScenarioBlueprintCandidate {
  const validated = validateNewGameInput(NEW_GAME_INPUT);
  if (!validated.ok) throw new Error("测试输入必须合法");
  return createFallbackBlueprint(validated.value, "phase1-wuxia-001", {
    profiles: loadScenarioProfiles()
  });
}

/** 测试专用：去掉根字段 readonly 并允许挂未知字段，便于构造非法候选。 */
type MutableCandidate = {
  -readonly [K in keyof ScenarioBlueprintCandidate]: ScenarioBlueprintCandidate[K];
} & Record<string, unknown>;

describe("repairScenarioCandidate", () => {
  it("合法候选原样通过且不被原地修改", () => {
    const candidate = buildValidCandidate();
    const snapshot = JSON.parse(JSON.stringify(candidate));
    const repaired = repairScenarioCandidate(candidate);
    expect(repaired).not.toBeNull();
    expect(repaired).toEqual(snapshot);
    expect(candidate).toEqual(snapshot);
  });

  it("只移除未知字段并裁剪超预算尾部项", () => {
    const candidate = buildValidCandidate() as MutableCandidate;
    candidate.extraPromptInstruction = "多余指令字段";
    candidate.npcs = [
      ...candidate.npcs,
      {
        id: "npc_7",
        name: "多余随从",
        role: "路人",
        description: "超预算第七人，未被任何地点引用。",
        locationId: "loc_2",
        isCompanion: false,
        knownFactIds: [],
        tags: []
      }
    ];
    const repaired = repairScenarioCandidate(candidate) as MutableCandidate | null;
    expect(repaired?.extraPromptInstruction).toBeUndefined();
    expect(repaired?.npcs).toHaveLength(6);
  });

  it("trim 字符串字段后仍需通过完整校验", () => {
    const candidate = buildValidCandidate() as MutableCandidate;
    candidate.generationId = `  ${candidate.generationId}  `;
    const repaired = repairScenarioCandidate(candidate);
    expect(repaired?.generationId).toBe(buildValidCandidate().generationId);
  });

  it("悬空引用不能被机械修复伪造成合法候选", () => {
    const candidate = buildValidCandidate() as MutableCandidate;
    candidate.npcs = candidate.npcs.map((npc, index) =>
      index === 0 ? { ...npc, knownFactIds: ["fact_missing"] } : npc
    );
    expect(repairScenarioCandidate(candidate)).toBeNull();
  });

  it("低于预算下限的候选不可修复", () => {
    const candidate = buildValidCandidate() as MutableCandidate;
    const kept = new Set(candidate.npcs.slice(0, 3).map((npc) => npc.id));
    candidate.npcs = candidate.npcs.slice(0, 3);
    candidate.locations = candidate.locations.map((location) => ({
      ...location,
      npcIds: location.npcIds.filter((id) => kept.has(id))
    }));
    candidate.openingScene = {
      ...candidate.openingScene,
      presentNpcIds: candidate.openingScene.presentNpcIds.filter((id) => kept.has(id))
    };
    expect(repairScenarioCandidate(candidate)).toBeNull();
  });
});
