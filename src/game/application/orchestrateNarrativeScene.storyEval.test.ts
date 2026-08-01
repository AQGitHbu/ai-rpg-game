import { describe, expect, it } from "vitest";
import { asFactId, asLocationId, asNpcId, type GameState, type ScenarioBlueprint } from "@/game/domain";
import { NARRATIVE_CONTRACT_VERSION, type DirectorSource, type SceneScriptSource, type NpcLineSource } from "./runtimeNarrative";
import { orchestrateNarrativeScene } from "./orchestrateNarrativeScene";
import type { StoryEvalApprovalEvent } from "./storyEvalCaptureTypes";

// 与 orchestrateNarrativeScene.test.ts 相同的构造助手（规格 §11 允许测试内复制）。
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
      facts: [{ id: asFactId("fact_1"), text: "公开事实1", source: "player_input" }],
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
      baseStats: { hp: 20, attack: 5, defense: 3 },
    },
    openingScene: {
      locationId: asLocationId("loc_a"),
      narration: "开始",
      suggestedActions: [],
      presentNpcIds: [asNpcId("npc_1")],
      investigableFactIds: [],
    },
  } as unknown as ScenarioBlueprint;
}

function buildTestGameState(): GameState {
  return {
    stateVersion: 1 as const,
    generation: {
      generationId: "gen-test" as GameState["generation"]["generationId"],
      seed: "test-seed",
      templateVersion: "tpl-1",
      inputDigest: "digest-test",
      gameType: "wuxia",
    },
    player: { name: "Player", identity: "Hero", stats: { hp: 20, attack: 5, defense: 3 } },
    currentLocationId: asLocationId("loc_a"),
    unlockedLocationIds: [asLocationId("loc_a")],
    visitedLocationIds: [asLocationId("loc_a")],
    // met: false 使 talk:npc_1 进入候选（与 orchestrateNarrativeScene.test.ts 规则行动文案用例
    // 同手法），保证 candidates ≥ 2 且两 key 不同——approveDirectorProposal 对
    // keyA === keyB 直接 choice_not_legal，mock 必须返回两个不同的合法 key。
    npcs: [{ npcId: asNpcId("npc_1"), locationId: asLocationId("loc_a"), met: false }],
    quests: [],
    inventory: [],
    worldFacts: [{ factId: asFactId("fact_1"), discovered: true }],
    defeatedEnemyIds: [],
    battle: { status: "idle" },
    ending: null,
    narrative: { currentScene: null, generation: { status: "idle" }, mode: "ai" },
    eventLedger: [{
      type: "game_initialized",
      generation: {
        generationId: "gen-test" as GameState["generation"]["generationId"],
        seed: "test-seed",
        templateVersion: "tpl-1",
        inputDigest: "digest-test",
        gameType: "wuxia",
      },
    }],
  } as unknown as GameState;
}

function createMockSources() {
  const directorSource: DirectorSource = {
    async generate(request) {
      const context = request.context as { actionCandidates?: { actionKey: string }[] };
      const candidates = context.actionCandidates ?? [];
      return {
        ok: true,
        provenance: "generated",
        plan: {
          sceneGoal: "目标",
          tensionLevel: 3,
          focusNpcId: asNpcId("npc_1"),
          relevantFactIds: [],
          allowedRevealFactIds: [],
          suggestedActionKeys: ["talk:npc_1", "observe:loc_a"] as [string, string],
          introducedEntities: [],
          pacing: "setup",
          proposedNewLocations: [],
          proposedNewNpcs: [],
        },
        diagnostics: { traceId: request.traceId, contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "candidate_received" },
      };
    },
  };
  const sceneScriptSource: SceneScriptSource = {
    async generate(request) {
      const context = request.context as { plan?: { suggestedActionKeys?: [string, string] } };
      const keys = context.plan?.suggestedActionKeys ?? ["talk:npc_1", "observe:loc_a"];
      return {
        ok: true,
        provenance: "generated",
        script: {
          narration: "叙事文本",
          usedFactIds: [],
          npcInstruction: {
            npcId: asNpcId("npc_1"),
            speechAct: "warn",
            emotion: "guarded",
            allowedFactIds: [],
            mayLie: false,
          },
          choices: [
            { actionKey: keys[0], label: "a", strategy: "s" },
            { actionKey: keys[1], label: "b", strategy: "t" },
          ],
        },
        diagnostics: { traceId: request.traceId, contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "candidate_received" },
      };
    },
  };
  const npcLineSource: NpcLineSource = {
    async generate(request) {
      return {
        ok: true,
        provenance: "generated",
        performance: { text: "台词", usedFactIds: [], emotion: "warm" },
        diagnostics: { traceId: request.traceId, contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "candidate_received" },
      };
    },
  };
  return { directorSource, sceneScriptSource, npcLineSource };
}

describe("orchestrateNarrativeScene approvalObserver", () => {
  it("成功链路依次发出 role_approval / plan_approved / expansion_decision 事件", async () => {
    const events: StoryEvalApprovalEvent[] = [];
    const result = await orchestrateNarrativeScene({
      traceId: "t-obs",
      blueprint: buildTestBlueprint(),
      state: buildTestGameState(),
      ...createMockSources(),
      approvalObserver: (event) => events.push(event),
    });
    expect(result.provenance).toBe("generated");
    // 事件顺序是采集契约而非巧合：director 审批 → 计划批准 → writer 审批 → npc 审批 → 扩展裁决。
    expect(events.map((event) => event.kind)).toEqual([
      "role_approval",   // director 通过
      "plan_approved",   // 已批准导演计划
      "role_approval",   // writer 通过
      "role_approval",   // npc 通过
      "expansion_decision",
    ]);
    const directorApproval = events[0];
    if (directorApproval.kind === "role_approval") {
      expect(directorApproval.role).toBe("director");
      expect(directorApproval.category).toBeNull();
      expect(directorApproval.attempt).toBe(1); // 1-based：编排层循环 0 转 1
    }
    const planApproved = events[1];
    if (planApproved.kind === "plan_approved") {
      expect(planApproved.planSummary).toMatchObject({ pacing: "setup", tensionLevel: 3 });
    }
    const expansion = events[4];
    if (expansion.kind === "expansion_decision") {
      expect(expansion.decision).toEqual({ ok: false, reason: "none_proposed" });
    }
  });

  it("审批驳回时发出带 category 的 role_approval 事件", async () => {
    const events: StoryEvalApprovalEvent[] = [];
    const { directorSource, sceneScriptSource, npcLineSource } = createMockSources();
    const rejectingDirector: DirectorSource = {
      async generate(request) {
        return {
          ok: true,
          provenance: "generated",
          // 引用不在任何候选中的 actionKey：approveDirectorProposal 必驳回。
          plan: {
            sceneGoal: "目标",
            tensionLevel: 3,
            focusNpcId: null,
            relevantFactIds: [],
            allowedRevealFactIds: [],
            suggestedActionKeys: ["move:nowhere", "move:nowhere2"],
            introducedEntities: [],
            pacing: "setup",
            proposedNewLocations: [],
            proposedNewNpcs: [],
          },
          diagnostics: { traceId: request.traceId, contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "candidate_received" },
        };
      },
    };
    const result = await orchestrateNarrativeScene({
      traceId: "t-reject",
      blueprint: buildTestBlueprint(),
      state: buildTestGameState(),
      directorSource: rejectingDirector,
      sceneScriptSource,
      npcLineSource,
      approvalObserver: (event) => events.push(event),
    });
    expect(result.provenance).toBe("fallback");
    const rejected = events.find((event) => event.kind === "role_approval");
    expect(rejected).toBeDefined();
    if (rejected?.kind === "role_approval") {
      expect(rejected.category).not.toBeNull();
    }
    // 驳回后没有 plan_approved
    expect(events.some((event) => event.kind === "plan_approved")).toBe(false);
  });
});
