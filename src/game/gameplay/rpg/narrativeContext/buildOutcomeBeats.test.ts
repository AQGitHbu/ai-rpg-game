import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { describe, expect, it } from "vitest";
import { createInitialStoryState } from "@/game/domain/storyState";
import type { MandatoryNarrativeBeat } from "@/game/domain/narrativeBeat";
import {
  baseWorld, quest, withQuest, withMet, withInventoryItem, withDiscoveredFact, withBattle, withNextAct,
  canonicalResolvedEvent, NPC_1_ID, NPC_2_ID, ITEM_SEAL_ID, ENEMY_WOLF_ID, FACT_1_ID,
} from "./narrativeContext.testutil";
import { asItemId, asNpcId } from "@/game/domain/worldEntity";
import type { ItemEntry, WorldState } from "@/game/domain/worldState";
import { buildOutcomeBeats, capMandatoryBeats } from "./buildOutcomeBeats";

const ss = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(),
  gameLength: "short",
  initialEntityCounts: { locations: 1, npcs: 1, quests: 0, events: 0 },
});

function beats(
  beforeWorldState = baseWorld(),
  afterWorldState = baseWorld(),
  afterStoryState = ss,
  extra: { readonly utterance?: string; readonly npcId?: ReturnType<typeof asNpcId> } = {},
) {
  return buildOutcomeBeats({
    resolvedEvent: canonicalResolvedEvent(),
    beforeWorldState,
    beforeStoryState: ss,
    afterWorldState,
    afterStoryState,
    ...extra,
  });
}

function oneOfKind(result: MandatoryNarrativeBeat[], kind: MandatoryNarrativeBeat["kind"]) {
  return result.filter((b) => b.kind === kind);
}

describe("buildOutcomeBeats（Task 4）", () => {
  it("item_obtained：subjectIds 含 item_seal，instruction 含盟誓印谱（来自当前状态，非事件原文）", () => {
    const after = withInventoryItem(baseWorld(), ITEM_SEAL_ID);
    const got = oneOfKind(beats(baseWorld(), after), "item_obtained");
    expect(got).toHaveLength(1);
    expect(got[0].subjectIds).toEqual([String(ITEM_SEAL_ID)]);
    expect(got[0].instruction).toContain("盟誓印谱");
  });

  it("fact_discovered：subjectIds 含 factId，instruction 含事实正文", () => {
    const after = withDiscoveredFact(baseWorld(), FACT_1_ID);
    const got = oneOfKind(beats(baseWorld(), after), "fact_discovered");
    expect(got).toHaveLength(1);
    expect(got[0].subjectIds).toEqual([String(FACT_1_ID)]);
    expect(got[0].instruction).toContain("矿坑里藏着密道");
  });

  it("quest_progress：本回合完成的目标进入节拍", () => {
    const before = withQuest(baseWorld(), quest([{ kind: "talk_to_npc", npcId: NPC_1_ID }]));
    const after = withMet(before);
    const got = oneOfKind(beats(before, after), "quest_progress");
    expect(got).toHaveLength(1);
    expect(got[0].instruction).toContain("与老板交谈");
  });

  it("quest_advanced：幕推进时发出新阶段节拍", () => {
    const before = withQuest(baseWorld(), quest([{ kind: "talk_to_npc", npcId: NPC_1_ID }]));
    const afterWorld = withNextAct(before);
    const advancedStory = { ...ss, currentAct: 2 };
    const got = oneOfKind(beats(before, afterWorld, advancedStory), "quest_advanced");
    expect(got).toHaveLength(1);
    expect(got[0].subjectIds).toEqual(["quest_dyn_1"]);
    expect(got[0].instruction).toContain("与信使交谈");
  });

  it("battle_started：战斗从空闲进入进行中", () => {
    const after = withBattle(baseWorld(), {
      status: "active", enemyId: ENEMY_WOLF_ID, playerHp: 100, enemyHp: 30, round: 1,
    });
    const got = oneOfKind(beats(baseWorld(), after), "battle_started");
    expect(got).toHaveLength(1);
    expect(got[0].subjectIds).toEqual([String(ENEMY_WOLF_ID)]);
    expect(got[0].instruction).toContain("野狼");
  });

  it("battle_round：回合推进并携带双方 HP", () => {
    const before = withBattle(baseWorld(), {
      status: "active", enemyId: ENEMY_WOLF_ID, playerHp: 100, enemyHp: 30, round: 1,
    });
    const after = withBattle(baseWorld(), {
      status: "active", enemyId: ENEMY_WOLF_ID, playerHp: 80, enemyHp: 15, round: 2,
    });
    const got = oneOfKind(beats(before, after), "battle_round");
    expect(got).toHaveLength(1);
    expect(got[0].instruction).toContain("第2回合");
    expect(got[0].instruction).toContain("80");
    expect(got[0].instruction).toContain("15");
  });

it("battle_resolved：胜利、败北与撤退均落节拍", () => {
    const before = withBattle(baseWorld(), {
      status: "active", enemyId: ENEMY_WOLF_ID, playerHp: 80, enemyHp: 5, round: 2,
    });
    const victory = withBattle(baseWorld(), { status: "resolved", enemyId: ENEMY_WOLF_ID, outcome: "victory" });
    const withdrawal = withBattle(baseWorld(), { status: "resolved", enemyId: ENEMY_WOLF_ID, outcome: "withdraw" });
    const defeat = withBattle(baseWorld(), { status: "resolved", enemyId: ENEMY_WOLF_ID, outcome: "defeat" });
    const win = oneOfKind(beats(before, victory), "battle_resolved");
    const withr = oneOfKind(beats(before, withdrawal), "battle_resolved");
    const def = oneOfKind(beats(before, defeat), "battle_resolved");
    expect(win).toHaveLength(1);
    expect(win[0].subjectIds).toEqual([String(ENEMY_WOLF_ID)]);
    expect(win[0].instruction).toContain("胜利");
    expect(withr).toHaveLength(1);
    expect(withr[0].instruction).toContain("撤退");
    expect(def).toHaveLength(1);
    expect(def[0].instruction).toContain("败北");
    expect(def[0].instruction).not.toContain("撤退");
  });

  it("entity_introduced：具象化的新 NPC/新任务进入节拍", () => {
    const before = withQuest(baseWorld(), quest([{ kind: "talk_to_npc", npcId: NPC_1_ID }]));
    const afterWorld = withNextAct(before);
    const result = beats(before, afterWorld, { ...ss, currentAct: 2 });
    const introduced = oneOfKind(result, "entity_introduced");
    expect(introduced.map((b) => b.subjectIds.join(",")).join(";")).toContain(String(NPC_2_ID));
    expect(introduced.map((b) => b.subjectIds.join(",")).join(";")).toContain("quest_dyn_1");
    expect(introduced.some((b) => b.instruction.includes("信使"))).toBe(true);
  });

  it("确定性：相同输入两次调用结果完全一致", () => {
    const before = withQuest(baseWorld(), quest([{ kind: "talk_to_npc", npcId: NPC_1_ID }]));
    const after = withMet(before);
    expect(beats(before, after)).toEqual(beats(before, after));
  });

  it("节拍上限：超过 8 条时保留最高优先级（battle 优先，entity_introduced 优先丢弃）", () => {
    const manyItems: readonly ItemEntry[] = Array.from({ length: 8 }, (_, i) => ({
      id: asItemId(`item_${i + 1}`), name: `物品${i + 1}`, description: "d", kind: "quest", tags: [],
    }));
    let after: WorldState = { ...baseWorld(), items: manyItems, inventory: manyItems.map((i) => i.id) };
    after = withDiscoveredFact(after);
    after = withBattle(after, { status: "active", enemyId: ENEMY_WOLF_ID, playerHp: 100, enemyHp: 30, round: 1 });
    const result = beats(baseWorld(), after);
    expect(result.length).toBeLessThanOrEqual(8);
    expect(oneOfKind(result, "battle_started")).toHaveLength(1);
    expect(oneOfKind(result, "fact_discovered")).toHaveLength(0);
    expect(oneOfKind(result, "entity_introduced")).toHaveLength(0);
  });

it("capMandatoryBeats：按固定优先级保留前 8 条且顺序稳定", () => {
    const kinds: MandatoryNarrativeBeat["kind"][] = [
      "entity_introduced", "item_obtained", "battle_resolved", "fact_discovered",
      "battle_started", "quest_progress", "quest_advanced", "battle_round", "player_utterance",
    ];
    const beats: MandatoryNarrativeBeat[] = kinds.map((kind, i) => ({
      beatId: `b${i}`, kind, subjectIds: [], instruction: "i",
    }));
    const capped = capMandatoryBeats(beats);
    expect(capped.length).toBe(8);
    expect(capped.map((b) => b.kind)).toEqual([
      "battle_resolved", "battle_started", "battle_round", "quest_advanced",
      "quest_progress", "item_obtained", "fact_discovered", "player_utterance",
    ]);
  });

  // ── Task 5 Step 4：player_utterance 节拍 ─────────────────────────────────

  it("有玩家原话且行动指向焦点 NPC 时，必须产出 player_utterance 节拍", () => {
    const got = oneOfKind(beats(baseWorld(), baseWorld(), ss, {
      utterance: "请问商队失踪的事你知道吗？",
      npcId: NPC_1_ID,
    }), "player_utterance");
    expect(got).toHaveLength(1);
    expect(got[0].subjectIds).toEqual([String(NPC_1_ID)]);
    expect(got[0].instruction.length).toBeGreaterThan(0);
  });

  it("无玩家原话 → 不产出 player_utterance 节拍", () => {
    const got = oneOfKind(beats(baseWorld(), baseWorld(), ss, { npcId: NPC_1_ID }), "player_utterance");
    expect(got).toHaveLength(0);
  });

  it("节拍挤爆上限时 player_utterance 仍保留（mandatory，替换最低优先级）", () => {
    const manyItems: readonly ItemEntry[] = Array.from({ length: 8 }, (_, i) => ({
      id: asItemId(`item_${i + 1}`), name: `物品${i + 1}`, description: "d", kind: "quest", tags: [],
    }));
    let after: WorldState = { ...baseWorld(), items: manyItems, inventory: manyItems.map((i) => i.id) };
    after = withBattle(after, { status: "active", enemyId: ENEMY_WOLF_ID, playerHp: 100, enemyHp: 30, round: 1 });
    const result = beats(baseWorld(), after, ss, {
      utterance: "我知道你在隐瞒什么",
      npcId: NPC_1_ID,
    });
    expect(result.length).toBeLessThanOrEqual(8);
    expect(oneOfKind(result, "player_utterance")).toHaveLength(1);
    expect(oneOfKind(result, "battle_started")).toHaveLength(1);
  });

  // ── Task 6：atmosphere 节拍恒在最后（可选表演段）───────────────────────

  it("恒产出 atmosphere 节拍且位于最后，总数不超过 8", () => {
    const result = beats(baseWorld(), baseWorld());
    const last = result[result.length - 1];
    expect(last?.beatId).toBe("atmosphere");
    expect(last?.kind).toBe("atmosphere");

    const manyItems: readonly ItemEntry[] = Array.from({ length: 8 }, (_, i) => ({
      id: asItemId(`item_${i + 1}`), name: `物品${i + 1}`, description: "d", kind: "quest", tags: [],
    }));
    const busy = beats(baseWorld(), { ...baseWorld(), items: manyItems, inventory: manyItems.map((i) => i.id) });
    expect(busy.length).toBeLessThanOrEqual(8);
    expect(busy[busy.length - 1]?.beatId).toBe("atmosphere");
  });
});
