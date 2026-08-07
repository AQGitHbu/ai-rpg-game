import { describe, expect, it } from "vitest";
import { createBudgetPolicy, validateNewGameInput, type NewGameInput, type ScenarioBlueprintCandidate } from "@/game/domain";
import { createFallbackBlueprint, loadScenarioProfiles } from "@/game/gameplay/rpg/scenario";
import { repairScenarioCandidate } from "./scenarioCandidateRecovery";

// ---------------------------------------------------------------------------
// 机械修复 helper 契约：只删未知根字段 / trim 字符串 / 裁剪超预算列表尾部；
// 悬空引用、任务图、tag、数值、文本内容一律不可修复（返回 null）。
// ---------------------------------------------------------------------------

const REPAIR_POLICY = createBudgetPolicy("short");

const NEW_GAME_INPUT: NewGameInput = {
  gameType: "wuxia",
  characterName: "沈青崖",
  characterIdentity: "落魄镖师",
  characterProfile: "青崖镖局独子，镖局一夜覆灭后流落江湖，靠押送散货为生。",
  personalityTags: ["坚毅", "重情义"],
  worldPremise: "镖局一夜覆灭，江湖各派暗流涌动，真凶身份成谜，官府与门派各怀心思。",
  storyOpening: "暮色四合，主角背着旧刀走进青石镇，镇口贴着一张字迹潦草的缉凶告示。",
  narrativeStyle: "novel",
  contentIntensity: "normal",
  gameLength: "short"
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
    const repaired = repairScenarioCandidate(candidate, { policy: REPAIR_POLICY });
    expect(repaired).not.toBeNull();
    expect(repaired).toEqual(snapshot);
    expect(candidate).toEqual(snapshot);
  });

  it("只移除未知字段并裁剪超预算尾部项", () => {
    const candidate = buildValidCandidate() as MutableCandidate;
    candidate.extraPromptInstruction = "多余指令字段";
    // v3 开局收窄仅 1 名 NPC：追加 6 名引用干净的 NPC 凑到 7 名必然超预算（coreNpcsMax=6）。
    const locationId = candidate.locations[0]?.id;
    if (locationId === undefined) throw new Error("fallback 候选必须含起始地点");
    const extras = Array.from({ length: 6 }, (_, index) => ({
      id: `npc_budget_${index + 1}`,
      name: `多余随从 ${index + 1}`,
      role: "路人",
      description: "超预算冗余 NPC，未被任何地点引用。",
      locationId,
      isCompanion: false,
      knownFactIds: [],
      tags: []
    }));
    candidate.npcs = [...candidate.npcs, ...extras];
    const repaired = repairScenarioCandidate(candidate, { policy: REPAIR_POLICY }) as MutableCandidate | null;
    expect(repaired?.extraPromptInstruction).toBeUndefined();
    expect(repaired?.npcs).toHaveLength(6);
  });

  it("非法物品展示稀有度只删除可选字段并保留物品本体", () => {
    const candidate = buildValidCandidate() as MutableCandidate;
    // v3 开局收窄无物品：从零构造一个合法物品 + 非法稀有度，验证只删展示字段。
    const sourceItem = {
      id: "item_display_invalid",
      name: "锈剑",
      description: "一把生锈的长剑。",
      category: "equipment",
      rarity: "legendary",
      tags: []
    } as unknown as (typeof candidate.items)[number];
    candidate.items = [...candidate.items, sourceItem];

    const repaired = repairScenarioCandidate(candidate, { policy: REPAIR_POLICY });
    const repairedItem = repaired?.items.find((item) => item.id === "item_display_invalid");

    expect(repairedItem).toMatchObject({ id: "item_display_invalid", name: sourceItem.name });
    expect(repairedItem?.rarity).toBeUndefined();
  });

  it("超预算尾部 NPC 被主线引用时，移除安全冗余 NPC 而保留引用 NPC", () => {
    const candidate = buildValidCandidate() as MutableCandidate;
    // v3 开局仅 1 名 NPC；追加 6 名凑到 7 名超预算，其中 npc_7 被主线 talk_to_npc 引用。
    const locationId = candidate.locations[0]?.id;
    if (locationId === undefined) throw new Error("fallback 候选必须含起始地点");
    const extras = Array.from({ length: 6 }, (_, index) => ({
      id: `npc_budget_${index + 1}`,
      name: `随从 ${index + 1}`,
      role: "路人",
      description: "超预算冗余 NPC。",
      locationId,
      isCompanion: false,
      knownFactIds: [],
      tags: []
    }));
    candidate.npcs = [...candidate.npcs, ...extras];
    candidate.locations = candidate.locations.map((location) => {
      const npcIds = location.npcIds.filter((id) => id !== "npc_budget_6");
      return location.id === locationId
        ? { ...location, npcIds: [...npcIds, "npc_budget_1"] }
        : { ...location, npcIds };
    });
    candidate.quests = candidate.quests.map((quest) =>
      quest.kind === "main"
        ? {
            ...quest,
            objectives: quest.objectives.map((objective) =>
              objective.kind === "talk_to_npc"
                ? { ...objective, npcId: "npc_budget_1" }
                : objective
            )
          }
        : quest
    );

    const repaired = repairScenarioCandidate(candidate, { policy: REPAIR_POLICY });

    expect(repaired).not.toBeNull();
    expect(repaired?.npcs).toHaveLength(6);
    expect(repaired?.npcs.some((npc) => npc.id === "npc_budget_1")).toBe(true);
    expect(repaired?.npcs.some((npc) => npc.id === "npc_budget_6")).toBe(false);
  });

  it("超预算 NPC 全部被引用时仍拒绝机械修复", () => {
    const candidate = buildValidCandidate() as MutableCandidate;
    // v3 开局仅 1 名 NPC；追加 6 名凑到 7 名超预算，全部被地点 npcIds 引用。
    const locationId = candidate.locations[0]?.id;
    if (locationId === undefined) throw new Error("fallback 候选必须含起始地点");
    const extras = Array.from({ length: 6 }, (_, index) => ({
      id: `npc_budget_${index + 1}`,
      name: `被引用随从 ${index + 1}`,
      role: "关键线人",
      description: "被地点引用的关键线人。",
      locationId,
      isCompanion: false,
      knownFactIds: [],
      tags: []
    }));
    candidate.npcs = [...candidate.npcs, ...extras];
    candidate.locations = candidate.locations.map((location) =>
      location.id === locationId
        ? {
            ...location,
            npcIds: [...location.npcIds, ...extras.map((npc) => npc.id)]
          }
        : location
    );

    expect(repairScenarioCandidate(candidate, { policy: REPAIR_POLICY })).toBeNull();
  });

  it("trim 字符串字段后仍需通过完整校验", () => {
    const candidate = buildValidCandidate() as MutableCandidate;
    candidate.generationId = `  ${candidate.generationId}  `;
    const repaired = repairScenarioCandidate(candidate, { policy: REPAIR_POLICY });
    expect(repaired?.generationId).toBe(buildValidCandidate().generationId);
  });

  it("悬空引用不能被机械修复伪造成合法候选", () => {
    const candidate = buildValidCandidate() as MutableCandidate;
    candidate.npcs = candidate.npcs.map((npc, index) =>
      index === 0 ? { ...npc, knownFactIds: ["fact_missing"] } : npc
    );
    expect(repairScenarioCandidate(candidate, { policy: REPAIR_POLICY })).toBeNull();
  });

  it("低于预算下限的候选不可修复", () => {
    const candidate = buildValidCandidate() as MutableCandidate;
    // v3 开局收窄下限为 1 地点 / 1 NPC：清空两者必然低于预算下限，
    // 机械修复只会裁剪尾部、绝不新增内容 ⇒ 返回 null。
    candidate.locations = [];
    candidate.npcs = [];
    expect(repairScenarioCandidate(candidate, { policy: REPAIR_POLICY })).toBeNull();
  });
});
