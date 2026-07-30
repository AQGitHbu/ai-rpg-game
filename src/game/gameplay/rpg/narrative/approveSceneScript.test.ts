import { describe, expect, it } from "vitest";
import { asFactId, asLocationId, asNpcId, type ScenarioBlueprint } from "@/game/domain";
import { approveSceneScript } from "./approveSceneScript";
import type { ApprovedDirectorPlan, SceneScriptProposal } from "./types";

function buildTestBlueprint(): ScenarioBlueprint {
  return {
    schemaVersion: 1 as const,
    generationId: "gen-test" as ScenarioBlueprint["generationId"],
    seed: "test-seed",
    templateVersion: "tpl-1",
    inputDigest: "digest-test",
    gameType: "wuxia",
    world: {
      name: "Test World",
      summary: "A test world",
      tone: "dark",
      themes: ["justice"],
      facts: [
        { id: asFactId("fact_1"), text: "公开事实1", source: "player_input" },
        { id: asFactId("fact_secret"), text: "NPC不知道的秘密", source: "generated" },
      ]
    },
    locations: [
      { id: asLocationId("loc_a"), name: "地点A", description: "", kind: "public", connectedLocationIds: [] },
    ],
    npcs: [
      { id: asNpcId("npc_1"), name: "NPC1", role: "村民", locationId: asLocationId("loc_a"), knownFactIds: [asFactId("fact_1")] },
    ],
    quests: [],
    enemies: [],
    items: [],
    endings: [],
    player: {
      name: "Player", identity: "Hero",
      startingItemIds: [],
      baseStats: { hp: 20, attack: 5, defense: 3 }
    },
    openingScene: {
      locationId: asLocationId("loc_a"),
      narration: "开始", suggestedActions: [],
      presentNpcIds: [asNpcId("npc_1")],
      investigableFactIds: [],
    },
  } as unknown as ScenarioBlueprint;
}

const approvedPlan: ApprovedDirectorPlan = {
  sceneGoal: "test goal",
  tensionLevel: 2,
  focusNpcId: "npc_1",
  relevantFactIds: ["fact_1"],
  allowedRevealFactIds: ["fact_1"],
  suggestedActionKeys: ["talk:npc_1", "investigate:fact_1"],
  introducedEntities: [],
  pacing: "develop",
};

const validScript: SceneScriptProposal = {
  narration: "雨声压低了酒馆里的交谈。",
  usedFactIds: ["fact_1"],
  npcInstruction: {
    npcId: "npc_1",
    speechAct: "evade",
    emotion: "guarded",
    allowedFactIds: ["fact_1"],
    mayLie: true,
  },
  choices: [
    { actionKey: "talk:npc_1", label: "继续追问", strategy: "施加压力逼出真相" },
    { actionKey: "investigate:fact_1", label: "检查登记册", strategy: "迂回收集证据" },
  ],
};

describe("approveSceneScript", () => {
  const blueprint = buildTestBlueprint();

  it("accepts a valid script", () => {
    const result = approveSceneScript({
      proposal: validScript,
      plan: approvedPlan,
      blueprint,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects NPC allowedFactIds not in NPC knownFactIds (knowledge_scope_violation)", () => {
    const result = approveSceneScript({
      proposal: {
        ...validScript,
        npcInstruction: {
          ...validScript.npcInstruction!,
          allowedFactIds: ["fact_secret"],
        },
      },
      plan: approvedPlan,
      blueprint,
    });
    expect(result).toMatchObject({ ok: false, category: "knowledge_scope_violation" });
  });

  it("rejects choices with action keys not matching approved plan", () => {
    const result = approveSceneScript({
      proposal: {
        ...validScript,
        choices: [
          { actionKey: "talk:npc_1", label: "继续追问", strategy: "施加压力" },
          { actionKey: "move:loc_hidden", label: "离开", strategy: "逃避" },
        ],
      },
      plan: approvedPlan,
      blueprint,
    });
    expect(result).toMatchObject({ ok: false, category: "choice_not_legal" });
  });

  it("rejects narration longer than 600 code points", () => {
    const result = approveSceneScript({
      proposal: {
        ...validScript,
        narration: "山".repeat(601),
      },
      plan: approvedPlan,
      blueprint,
    });
    expect(result).toMatchObject({ ok: false, category: "schema_violation" });
  });

  it("rejects empty narration", () => {
    const result = approveSceneScript({
      proposal: {
        ...validScript,
        narration: "",
      },
      plan: approvedPlan,
      blueprint,
    });
    expect(result).toMatchObject({ ok: false, category: "schema_violation" });
  });

  it("rejects choice label longer than 40 code points", () => {
    const result = approveSceneScript({
      proposal: {
        ...validScript,
        choices: [
          { actionKey: "talk:npc_1", label: "选".repeat(41), strategy: "test" },
          { actionKey: "investigate:fact_1", label: "调查", strategy: "test" },
        ],
      },
      plan: approvedPlan,
      blueprint,
    });
    expect(result).toMatchObject({ ok: false, category: "schema_violation" });
  });

  it("rejects usedFactIds not subset of allowedRevealFactIds", () => {
    const result = approveSceneScript({
      proposal: {
        ...validScript,
        usedFactIds: ["fact_secret"],
      },
      plan: approvedPlan,
      blueprint,
    });
    expect(result).toMatchObject({ ok: false, category: "knowledge_scope_violation" });
  });
});
