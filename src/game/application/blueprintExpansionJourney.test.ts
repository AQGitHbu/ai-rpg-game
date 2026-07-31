import { describe, expect, it } from "vitest";
import { asLocationId, createBudgetPolicy, type GameState, type NewGameInput, type ScenarioBlueprint } from "@/game/domain";
import { actionKeyOf, type ProposedNewLocation, type ProposedNewNpc } from "@/game/gameplay/rpg/narrative";
import { projectAvailableActions } from "@/game/gameplay/rpg/actions";
import {
  asGameId,
  type ApplyBlueprintExpansionInput,
  type ApplyResolvedActionInput,
  type GameRecord,
  type GameRepository,
} from "./server/persistence/gameRepository";
import type { DirectorSource, NpcLineSource, SceneScriptSource } from "./runtimeNarrative";
import { orchestrateNarrativeScene } from "./orchestrateNarrativeScene";
import { generatePendingNarrativeScene } from "./generatePendingNarrativeScene";
import { projectLocationAdventureView } from "./locationAdventureView";
import { runScenarioPipeline } from "./applicationFixture.testutil";
import wuxiaFixture from "../../../data/fixtures/phase1/wuxia.json";

// ---------------------------------------------------------------------------
// 蓝图扩展离线旅程回归（spec §6 验收 6/7）：
// 导演提案 → 审批 → 编排返回 expansionDecision → generatePendingNarrativeScene
// 单次 CAS 落库 → 地图出现新节点 / 可移动进入 / blueprint_expanded 事件；
// 以及拒绝路径（pacing / soft cap / STALE）下场景照常保存、蓝图不变。
// ---------------------------------------------------------------------------

type Phase1Fixture = { input: NewGameInput; seed: string };
const fixture = wuxiaFixture as unknown as Phase1Fixture;

const VALID_LOCATION_PROPOSAL: ProposedNewLocation = {
  name: "青雾渡口",
  description: "江边荒废的渡口，夜雾终年不散，旧船家传闻里藏着不为人知的往事。",
  scale: "scene",
  connectFromLocationId: "loc_1",
  reason: "剧情需要一个隐秘的会面地点来推进主线调查。",
};

const VALID_NPC_PROPOSAL: ProposedNewNpc = {
  name: "老船夫",
  role: "渡口船夫",
  description: "常年守着渡口的老人，见过许多深夜过江的可疑身影。",
  locationId: "new:0",
};

function pendingRecord(): GameRecord {
  const { blueprint, state } = runScenarioPipeline(fixture.input, fixture.seed);
  return {
    gameId: asGameId("expansion-journey-test"),
    blueprint,
    state: {
      ...state,
      narrative: {
        currentScene: null,
        generation: { status: "pending", requestedAt: "2026-07-30T08:00:00.000Z" },
        mode: "ai",
      },
    },
    revision: 4,
    createdAt: "2026-07-30T08:00:00.000Z",
  };
}

/** 导演 fake：从上下文取前两个合法 actionKey，附带指定扩展提案与 pacing。 */
function proposingDirector(options: {
  readonly proposedNewLocations: readonly ProposedNewLocation[];
  readonly proposedNewNpcs: readonly ProposedNewNpc[];
  readonly pacing?: "setup" | "develop" | "turn" | "climax" | "resolution";
}): DirectorSource {
  return {
    async generate(request) {
      const ctx = request.context as { actionCandidates: readonly { actionKey: string }[] };
      return {
        ok: true,
        provenance: "generated",
        plan: {
          sceneGoal: "沿旧线索追查下去",
          tensionLevel: 2,
          focusNpcId: null,
          relevantFactIds: [],
          allowedRevealFactIds: [],
          suggestedActionKeys: [ctx.actionCandidates[0].actionKey, ctx.actionCandidates[1].actionKey],
          introducedEntities: [],
          pacing: options.pacing ?? "develop",
          proposedNewLocations: options.proposedNewLocations,
          proposedNewNpcs: options.proposedNewNpcs,
        },
        diagnostics: {
          traceId: request.traceId,
          contractVersion: "runtime-narrative-v2",
          stage: "candidate_received",
        },
      } as never;
    },
  };
}

/** 编剧 fake：复制导演计划的 suggestedActionKeys，npcInstruction 为 null（跳过演员）。 */
function echoScriptSource(): SceneScriptSource {
  return {
    async generate(request) {
      const ctx = request.context as { plan: { suggestedActionKeys: readonly [string, string] } };
      return {
        ok: true,
        provenance: "generated",
        script: {
          narration: "雾色渐浓，你在旧码头的石阶前停下脚步，权衡着下一步。",
          usedFactIds: [],
          npcInstruction: null,
          choices: [
            { actionKey: ctx.plan.suggestedActionKeys[0], label: "谨慎前行", strategy: "稳妥推进当前线索" },
            { actionKey: ctx.plan.suggestedActionKeys[1], label: "另寻他路", strategy: "换一个切入角度" },
          ],
        },
        diagnostics: {
          traceId: request.traceId,
          contractVersion: "runtime-narrative-v2",
          stage: "candidate_received",
        },
      } as never;
    },
  };
}

function unusedNpcLineSource(): NpcLineSource {
  return {
    async generate() {
      throw new Error("npc performer must not run when npcInstruction is null");
    },
  };
}

function sourcesWith(director: DirectorSource) {
  return {
    directorSource: director,
    sceneScriptSource: echoScriptSource(),
    npcLineSource: unusedNpcLineSource(),
  };
}

/** 有状态 fake repository：记录两条写入通道，成功时推进 revision。 */
function statefulRepository(record: GameRecord) {
  let current = record;
  const applyCalls: ApplyResolvedActionInput[] = [];
  const expansionCalls: ApplyBlueprintExpansionInput[] = [];
  let expansionStale = false;
  const repository: GameRepository = {
    async createInitialGame() { return { ok: true }; },
    async getCurrentGame() { return { ok: true as const, status: "active" as const, record: current }; },
    async applyResolvedAction(input) {
      applyCalls.push(input);
      current = { ...current, state: input.nextState, revision: current.revision + 1 };
      return { ok: true as const, record: current };
    },
    async applyBlueprintExpansion(input) {
      expansionCalls.push(input);
      if (expansionStale) return { ok: false as const, code: "STALE_GAME_REVISION" as const };
      current = { ...current, blueprint: input.nextBlueprint, state: input.nextState, revision: current.revision + 1 };
      return { ok: true as const, record: current };
    },
  };
  return {
    repository,
    applyCalls,
    expansionCalls,
    get current() { return current; },
    markExpansionStale() { expansionStale = true; },
  };
}

describe("blueprintExpansionJourney：编排层扩展决策", () => {
  it("导演附带合法提案时，expansionDecision 通过并携带重建后的提案", async () => {
    const record = pendingRecord();
    const result = await orchestrateNarrativeScene({
      traceId: "journey-approve",
      blueprint: record.blueprint,
      state: record.state,
      ...sourcesWith(proposingDirector({
        proposedNewLocations: [VALID_LOCATION_PROPOSAL],
        proposedNewNpcs: [VALID_NPC_PROPOSAL],
      })),
    });

    expect(result.provenance).toBe("generated");
    expect(result.expansionDecision).toEqual({
      ok: true,
      expansion: { newLocation: VALID_LOCATION_PROPOSAL, newNpc: VALID_NPC_PROPOSAL },
    });
  });

  it("导演无提案时返回 none_proposed，场景照常生成", async () => {
    const record = pendingRecord();
    const result = await orchestrateNarrativeScene({
      traceId: "journey-none",
      blueprint: record.blueprint,
      state: record.state,
      ...sourcesWith(proposingDirector({ proposedNewLocations: [], proposedNewNpcs: [] })),
    });

    expect(result.provenance).toBe("generated");
    expect(result.expansionDecision).toEqual({ ok: false, reason: "none_proposed" });
  });

  it("导演失败走 fallback 时固定返回 none_proposed", async () => {
    const record = pendingRecord();
    const failingDirector: DirectorSource = {
      async generate() {
        return {
          ok: false,
          provenance: "unavailable",
          category: "service_error",
          diagnostics: {
            traceId: "journey-fallback",
            contractVersion: "runtime-narrative-v2",
            stage: "failed",
            category: "service_error",
          },
        };
      },
    };
    const result = await orchestrateNarrativeScene({
      traceId: "journey-fallback",
      blueprint: record.blueprint,
      state: record.state,
      ...sourcesWith(failingDirector),
    });

    expect(result.provenance).toBe("fallback");
    expect(result.expansionDecision).toEqual({ ok: false, reason: "none_proposed" });
  });
});

describe("blueprintExpansionJourney：落库与视图旅程", () => {
  it("提案通过 → 场景与扩展同一次 CAS 落库，地图出现新节点且可移动进入", async () => {
    const repo = statefulRepository(pendingRecord());
    const result = await generatePendingNarrativeScene({
      repository: repo.repository,
      newTraceId: () => "journey-persist",
      runtimeNarrativeSources: sourcesWith(proposingDirector({
        proposedNewLocations: [VALID_LOCATION_PROPOSAL],
        proposedNewNpcs: [VALID_NPC_PROPOSAL],
      })),
    });

    expect(result).toBe("saved");
    // 扩展与场景走同一条 applyBlueprintExpansion 通道，绝不双写
    expect(repo.applyCalls).toHaveLength(0);
    expect(repo.expansionCalls).toHaveLength(1);
    const write = repo.expansionCalls[0];
    expect(write.expectedRevision).toBe(4);

    // 蓝图：服务端铸造 ID + 双向连通 + "new:0" 解析到新地点
    const newLoc = write.nextBlueprint.locations.find((l) => String(l.id) === "loc_dyn_1");
    expect(newLoc?.name).toBe(VALID_LOCATION_PROPOSAL.name);
    expect(newLoc?.connectedLocationIds.map(String)).toContain("loc_1");
    const anchor = write.nextBlueprint.locations.find((l) => String(l.id) === "loc_1");
    expect(anchor?.connectedLocationIds.map(String)).toContain("loc_dyn_1");
    const newNpc = write.nextBlueprint.npcs.find((n) => String(n.id) === "npc_dyn_1");
    expect(newNpc?.name).toBe(VALID_NPC_PROPOSAL.name);
    expect(String(newNpc?.locationId)).toBe("loc_dyn_1");

    // 状态：场景保存 + 新地点解锁 + NPC runtime 条目 + blueprint_expanded 事件
    expect(write.nextState.narrative.currentScene?.source).toBe("generated");
    expect(write.nextState.narrative.generation).toEqual({ status: "idle" });
    expect(write.nextState.unlockedLocationIds.map(String)).toContain("loc_dyn_1");
    expect(write.nextState.npcs.some((n) => String(n.npcId) === "npc_dyn_1")).toBe(true);
    const lastEvent = write.nextState.eventLedger[write.nextState.eventLedger.length - 1];
    expect(lastEvent).toMatchObject({
      type: "blueprint_expanded",
      newLocationIds: ["loc_dyn_1"],
      newNpcIds: ["npc_dyn_1"],
    });

    // 旅程收尾：场景结束后（currentScene 置空）新地点出现在地图且可移动进入
    const settled: GameState = {
      ...repo.current.state,
      narrative: { ...repo.current.state.narrative, currentScene: null },
    };
    const actions = projectAvailableActions(repo.current.blueprint, settled);
    expect(actions.map(actionKeyOf)).toContain("move:loc_dyn_1");
    const view = projectLocationAdventureView(repo.current.blueprint, settled, actions);
    expect(view.worldMap.nodes.some((n) => "locationId" in n && n.locationId === "loc_dyn_1")).toBe(true);
  });

  it("pacing climax 时扩展被拒（pacing_locked），场景仍照常保存且蓝图不变", async () => {
    const repo = statefulRepository(pendingRecord());
    const result = await generatePendingNarrativeScene({
      repository: repo.repository,
      newTraceId: () => "journey-pacing",
      runtimeNarrativeSources: sourcesWith(proposingDirector({
        proposedNewLocations: [VALID_LOCATION_PROPOSAL],
        proposedNewNpcs: [],
        pacing: "climax",
      })),
    });

    expect(result).toBe("saved");
    expect(repo.expansionCalls).toHaveLength(0);
    expect(repo.applyCalls).toHaveLength(1);
    expect(repo.applyCalls[0].nextState.narrative.currentScene?.source).toBe("generated");
    expect(repo.current.blueprint.locations.some((l) => String(l.id) === "loc_dyn_1")).toBe(false);
    expect(repo.current.state.eventLedger.some((e) => e.type === "blueprint_expanded")).toBe(false);
  });

  it("short 档地点达软上限时扩展被拒（soft_cap_reached），场景仍照常保存", async () => {
    const record = pendingRecord();
    const template = record.blueprint.locations[1];
    const padding = [1, 2, 3].map((i) => ({
      ...template,
      id: asLocationId(`loc_pad_${i}`),
      connectedLocationIds: [],
    }));
    const cappedBlueprint = {
      ...record.blueprint,
      budgetPolicy: createBudgetPolicy("short"),
      locations: [...record.blueprint.locations, ...padding],
    } as ScenarioBlueprint;
    const repo = statefulRepository({ ...record, blueprint: cappedBlueprint });

    const result = await generatePendingNarrativeScene({
      repository: repo.repository,
      newTraceId: () => "journey-softcap",
      runtimeNarrativeSources: sourcesWith(proposingDirector({
        proposedNewLocations: [VALID_LOCATION_PROPOSAL],
        proposedNewNpcs: [],
      })),
    });

    expect(result).toBe("saved");
    expect(repo.expansionCalls).toHaveLength(0);
    expect(repo.applyCalls).toHaveLength(1);
    expect(repo.applyCalls[0].nextState.narrative.currentScene?.source).toBe("generated");
    expect(repo.current.blueprint.locations.some((l) => String(l.id) === "loc_dyn_1")).toBe(false);
  });

  it("扩展写入遇 STALE_GAME_REVISION 时返回 stale，允许恢复端点重试", async () => {
    const repo = statefulRepository(pendingRecord());
    repo.markExpansionStale();
    const result = await generatePendingNarrativeScene({
      repository: repo.repository,
      newTraceId: () => "journey-stale",
      runtimeNarrativeSources: sourcesWith(proposingDirector({
        proposedNewLocations: [VALID_LOCATION_PROPOSAL],
        proposedNewNpcs: [VALID_NPC_PROPOSAL],
      })),
    });

    expect(result).toBe("stale");
    expect(repo.expansionCalls).toHaveLength(1);
    expect(repo.applyCalls).toHaveLength(0);
  });
});
