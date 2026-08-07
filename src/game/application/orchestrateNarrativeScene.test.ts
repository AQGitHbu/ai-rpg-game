import { describe, expect, it } from "vitest";
import { asFactId, asLocationId, asNpcId, type GameState, type ScenarioBlueprint } from "@/game/domain";
import { createGameLogger, type GameLogEntry } from "@/game/logging";
import { NARRATIVE_CONTRACT_VERSION, type DirectorSource, type SceneScriptSource, type NpcLineSource } from "./runtimeNarrative";
import { orchestrateNarrativeScene } from "./orchestrateNarrativeScene";

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
      ]
    },
    locations: [
      { id: asLocationId("loc_a"), name: "地点A", description: "", kind: "public", connectedLocationIds: [] },
    ],
    npcs: [
      { id: asNpcId("npc_1"), name: "NPC1", role: "村民", description: "守着渡口、对外来者保持警惕的村民。", locationId: asLocationId("loc_a"), knownFactIds: [asFactId("fact_1")] },
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
    npcs: [{ npcId: asNpcId("npc_1"), locationId: asLocationId("loc_a"), met: true }],
    quests: [],
    inventory: [],
    worldFacts: [
      { factId: asFactId("fact_1"), discovered: true },
    ],
    defeatedEnemyIds: [],
    battle: { status: "idle" },
    ending: null,
    // 与 domain 真实形态一致：narrative.generation 是必选字段（toDirectorContext 直接读取 status）。
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

describe("orchestrateNarrativeScene fallback", () => {
  const blueprint = buildTestBlueprint();
  const state = buildTestGameState();

  it("当 director source 失败时返回 fallback scene", async () => {
    let directorCalls = 0;
    const failingDirector: DirectorSource = {
      async generate(_request) {
        directorCalls += 1;
        return {
          ok: false,
          provenance: "unavailable",
          category: "service_error",
          diagnostics: {
            traceId: "test-director",
            contractVersion: NARRATIVE_CONTRACT_VERSION,
            stage: "failed",
            category: "service_error",
          },
        } as never;
      },
    };

    const mockScriptSource: SceneScriptSource = {
      async generate(_request) {
        return {
          ok: false,
          provenance: "unavailable",
          category: "service_error",
          diagnostics: {
            traceId: "test-script",
            contractVersion: NARRATIVE_CONTRACT_VERSION,
            stage: "failed",
            category: "service_error",
          },
        };
      },
    };

    const mockNpcSource = {
      async generate(_request: Parameters<SceneScriptSource["generate"]>[0]) {
        return { ok: false as const, provenance: "unavailable" as const, category: "service_error" as const, diagnostics: { traceId: "test", contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "failed" as const } };
      },
    };

    const result = await orchestrateNarrativeScene({
      traceId: "test-fallback",
      blueprint,
      state,
      directorSource: failingDirector,
      sceneScriptSource: mockScriptSource,
      npcLineSource: mockNpcSource,
    });

    expect(result.provenance).toBe("fallback");
    expect(result.scene.source).toBe("fallback");
    expect(result.scene.narration.length).toBeGreaterThan(0);
    expect(result.scene.choices).toHaveLength(2);
    expect(directorCalls).toBe(3);
  });

  it("开局对白 fallback 保留焦点 NPC 与两个对白选项", async () => {
    const dialogueState: GameState = {
      ...state,
      narrative: {
        ...state.narrative,
        generation: {
          status: "pending",
          requestedAt: "2026-08-06T00:00:00.000Z",
          triggerContext: { kind: "initial_opening", npcId: asNpcId("npc_1") },
        },
      },
    };
    const unavailable = {
      async generate() {
        return {
          ok: false as const,
          provenance: "unavailable" as const,
          category: "service_error" as const,
          diagnostics: {
            traceId: "test",
            contractVersion: NARRATIVE_CONTRACT_VERSION,
            stage: "failed" as const,
            category: "service_error" as const,
          },
        };
      },
    };

    const result = await orchestrateNarrativeScene({
      traceId: "test-dialogue-fallback",
      blueprint,
      state: dialogueState,
      directorSource: unavailable,
      sceneScriptSource: unavailable,
      npcLineSource: unavailable,
      maxRoleAttempts: 1,
    });

    expect(result.scene.event).toEqual({ kind: "dialogue", focusNpcId: asNpcId("npc_1") });
    expect(result.scene.npcDialogues?.map((dialogue) => String(dialogue.npcId))).toEqual(["npc_1"]);
    expect(result.scene.choices.map((choice) => choice.label)).toEqual([
      "请问一下目前状况是怎么样的？",
      "是否可以告诉我事情的缘由？",
    ]);
    expect(result.scene.choices.every((choice) => choice.choiceKind === "dialogue_response")).toBe(true);
    expect(result.scene.dialogueFollowups).toHaveLength(2);
  });

  it("评估模式可把 director 重试限制为一次", async () => {
    let directorCalls = 0;
    const result = await orchestrateNarrativeScene({
      traceId: "test-eval-attempt-limit",
      blueprint,
      state,
      maxRoleAttempts: 1,
      directorSource: {
        async generate() {
          directorCalls += 1;
          return {
            ok: false as const,
            provenance: "unavailable" as const,
            category: "service_error" as const,
            diagnostics: { traceId: "test", contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "failed" as const, category: "service_error" as const },
          };
        },
      },
      sceneScriptSource: { async generate() { throw new Error("not reached"); } },
      npcLineSource: { async generate() { throw new Error("not reached"); } },
    });

    expect(result.provenance).toBe("fallback");
    expect(directorCalls).toBe(1);
  });

  it("生产开局快速路径只尝试一次 director，避免同一 schema 错误拖延数分钟", async () => {
    let directorCalls = 0;
    let directorTimeoutMs: number | undefined;
    const result = await orchestrateNarrativeScene({
      traceId: "test-fast-opening",
      blueprint,
      state: {
        ...state,
        narrative: {
          ...state.narrative,
          generation: {
            status: "pending",
            requestedAt: "2026-08-06T00:00:00.000Z",
            triggerContext: { kind: "initial_opening", npcId: asNpcId("npc_1") },
          },
        },
      },
      fastFirstScene: true,
      directorSource: {
        async generate(request) {
          directorCalls += 1;
          directorTimeoutMs = request.timeoutMs;
          return {
            ok: true as const,
            provenance: "generated" as const,
            plan: {
              sceneGoal: "invalid plan",
              tensionLevel: 0,
              focusNpcId: null,
              relevantFactIds: [],
              allowedRevealFactIds: [],
              suggestedActionKeys: ["invalid:first", "invalid:second"],
              introducedEntities: [],
              pacing: "setup",
            },
            diagnostics: { traceId: "test", contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "candidate_received" as const },
          } as never;
        },
      },
      sceneScriptSource: { async generate() { throw new Error("not reached"); } },
      npcLineSource: { async generate() { throw new Error("not reached"); } },
    });

    expect(result.provenance).toBe("fallback");
    expect(directorCalls).toBe(1);
    expect(directorTimeoutMs).toBe(30_000);
  });

  it("报告脱敏的角色阶段进度，UI 可区分当前尝试与已完成阶段", async () => {
    const progress: Array<{ completedCalls: number; totalCalls: 3; currentRole: string; attempt: number }> = [];
    const unavailable = {
      async generate() {
        return {
          ok: false as const,
          provenance: "unavailable" as const,
          category: "service_error" as const,
          diagnostics: { traceId: "progress", contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "failed" as const, category: "service_error" as const },
        };
      },
    };

    await orchestrateNarrativeScene({
      traceId: "progress-test",
      blueprint,
      state: {
        ...state,
        narrative: {
          ...state.narrative,
          generation: {
            status: "pending",
            requestedAt: "2026-08-06T00:00:00.000Z",
            triggerContext: { kind: "initial_opening", npcId: asNpcId("npc_1") },
          },
        },
      },
      fastFirstScene: true,
      directorSource: unavailable,
      sceneScriptSource: unavailable,
      npcLineSource: unavailable,
      progressObserver: (event) => progress.push(event),
    });

    expect(progress[0]).toEqual({ completedCalls: 0, totalCalls: 3, currentRole: "director", attempt: 1 });
  });

  it("director 重试不会把同一角色的多次成功响应累计成已完成阶段", async () => {
    const progress: Array<{ completedCalls: number; totalCalls: 3; currentRole: string; attempt: number }> = [];
    const rejectedDirector = {
      async generate() {
        return {
          ok: true as const,
          provenance: "generated" as const,
          plan: {
            sceneGoal: "无效提案",
            tensionLevel: 1 as const,
            focusNpcId: null,
            relevantFactIds: [],
            allowedRevealFactIds: [],
            suggestedActionKeys: ["invalid:a", "invalid:b"] as const,
            introducedEntities: [],
            proposedNewLocations: [],
            proposedNewNpcs: [],
            pacing: "setup" as const,
          },
          diagnostics: { traceId: "retry", contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "candidate_received" as const },
        };
      },
    };
    const unavailable = {
      async generate() {
        throw new Error("not reached");
      },
    };

    await orchestrateNarrativeScene({
      traceId: "progress-retry",
      blueprint,
      state,
      directorSource: rejectedDirector,
      sceneScriptSource: unavailable,
      npcLineSource: unavailable,
      progressObserver: (event) => progress.push(event),
    });

    expect(progress.filter((event) => event.currentRole === "director").at(-1)).toEqual({
      completedCalls: 0,
      totalCalls: 3,
      currentRole: "director",
      attempt: 3,
    });
  });

  it("记录被规则拒绝的 director 提案，但不写入提案内容", async () => {
    const entries: GameLogEntry[] = [];
    const result = await orchestrateNarrativeScene({
      traceId: "test-rejected-proposal",
      blueprint,
      state,
      directorSource: {
        async generate() {
          return {
            ok: true,
            provenance: "generated",
            plan: {
              sceneGoal: "不应进入日志",
              tensionLevel: 1,
              focusNpcId: null,
              relevantFactIds: [],
              allowedRevealFactIds: [],
              suggestedActionKeys: ["invalid:first", "invalid:second"],
              introducedEntities: [],
              pacing: "setup"
            },
            diagnostics: {
              traceId: "test-rejected-proposal-director",
              contractVersion: NARRATIVE_CONTRACT_VERSION,
              stage: "candidate_received"
            }
          } as never;
        }
      },
      sceneScriptSource: { async generate() { throw new Error("not reached"); } },
      npcLineSource: { async generate() { throw new Error("not reached"); } },
      logger: createGameLogger({ write: (entry) => entries.push(entry) })
    });

    expect(result.provenance).toBe("fallback");
    expect(entries).toContainEqual({
      level: "warn",
      event: "runtime_narrative_approval",
      details: {
        traceId: "test-rejected-proposal",
        role: "director",
        category: "choice_not_legal"
      }
    });
    expect(JSON.stringify(entries)).not.toContain("不应进入日志");
  });
});

describe("orchestrateNarrativeScene：Phase 11 pacing continuity 告警去重", () => {
  const blueprint = buildTestBlueprint();
  const state = buildTestGameState();

  it("同场景内 pacing continuity_violation 至多记录一次（重试不重复告警）", async () => {
    const entries: GameLogEntry[] = [];
    const result = await orchestrateNarrativeScene({
      traceId: "test-continuity-once",
      blueprint,
      state,
      directorSource: {
        async generate() {
          return {
            ok: true,
            provenance: "generated",
            plan: {
              sceneGoal: "推进",
              tensionLevel: 2,
              focusNpcId: null,
              relevantFactIds: [],
              allowedRevealFactIds: [],
              suggestedActionKeys: ["x:a", "x:b"],
              introducedEntities: [],
              pacing: "climax"
            },
            diagnostics: { traceId: "t", contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "candidate_received" }
          } as never;
        }
      },
      sceneScriptSource: { async generate() { throw new Error("not reached"); } },
      npcLineSource: { async generate() { throw new Error("not reached"); } },
      logger: createGameLogger({ write: (entry) => entries.push(entry) })
    });

    expect(result.provenance).toBe("fallback");
    const continuityWarns = entries.filter(
      (entry) =>
        entry.level === "warn" &&
        entry.event === "runtime_narrative_approval" &&
        (entry.details as { category?: string }).category === "continuity_violation"
    );
    expect(continuityWarns).toHaveLength(1);
  });
});

describe("orchestrateNarrativeScene：规则行动文案", () => {
  const blueprint = buildTestBlueprint();
  const state = buildTestGameState();

  it("忽略会误导玩家的模型 choice 文案，保存与 actionKey 匹配的规则标签", async () => {
    const unmetState = {
      ...state,
      npcs: [{ npcId: asNpcId("npc_1"), locationId: asLocationId("loc_a"), met: false }],
    } as GameState;
    const result = await orchestrateNarrativeScene({
      traceId: "test-authoritative-choice-copy",
      blueprint,
      state: unmetState,
      directorSource: {
        async generate() {
          return {
            ok: true,
            provenance: "generated",
            plan: {
              sceneGoal: "承接",
              tensionLevel: 2,
              focusNpcId: null,
              relevantFactIds: [],
              allowedRevealFactIds: [],
              suggestedActionKeys: ["talk:npc_1", "observe:loc_a"],
              introducedEntities: [],
              pacing: "setup",
            },
            diagnostics: { traceId: "director", contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "candidate_received" },
          } as never;
        },
      },
      sceneScriptSource: {
        async generate() {
          return {
            ok: true,
            provenance: "generated",
            script: {
              narration: "局势未明。",
              usedFactIds: [],
              npcInstruction: null,
              choices: [
                { actionKey: "talk:npc_1", label: "离开此地", strategy: "立刻远行" },
                { actionKey: "observe:loc_a", label: "攻击守卫", strategy: "发动战斗" },
              ],
            },
            diagnostics: { traceId: "writer", contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "candidate_received" },
          } as never;
        },
      },
      npcLineSource: { async generate() { throw new Error("not reached"); } },
    });

    expect(result.provenance).toBe("generated");
    expect(result.scene.choices).toEqual([
      expect.objectContaining({ actionKey: "talk:npc_1", label: "与NPC1交谈" }),
      expect.objectContaining({ actionKey: "observe:loc_a", label: "观察地点A" }),
    ]);
  });
});

describe("orchestrateNarrativeScene：NPC 角色交接", () => {
  it("把编剧的场景目标与情绪交给演员，并保留角色语义档案", async () => {
    const blueprint = buildTestBlueprint();
    const state = { ...buildTestGameState(), npcs: [{ npcId: asNpcId("npc_1"), locationId: asLocationId("loc_a"), met: false }] } as GameState;
    let receivedContext: Record<string, unknown> | undefined;
    const result = await orchestrateNarrativeScene({
      traceId: "test-npc-handoff",
      blueprint,
      state,
      directorSource: {
        async generate() {
          return {
            ok: true,
            provenance: "generated",
            plan: {
              sceneGoal: "让守门人透露渡口异常",
              tensionLevel: 3,
              focusNpcId: "npc_1",
              relevantFactIds: ["fact_1"],
              allowedRevealFactIds: ["fact_1"],
              suggestedActionKeys: ["talk:npc_1", "observe:loc_a"],
              introducedEntities: [],
              pacing: "develop",
            },
            diagnostics: { traceId: "director", contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "candidate_received" },
          } as never;
        },
      },
      sceneScriptSource: {
        async generate() {
          return {
            ok: true,
            provenance: "generated",
            script: {
              narration: "守门人盯着你的来意。",
              usedFactIds: [],
              npcInstruction: { npcId: "npc_1", speechAct: "warn", emotion: "afraid", allowedFactIds: ["fact_1"], mayLie: false },
              choices: [
                { actionKey: "talk:npc_1", label: "交谈", strategy: "试探" },
                { actionKey: "observe:loc_a", label: "观察", strategy: "寻找痕迹" },
              ],
            },
            diagnostics: { traceId: "writer", contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "candidate_received" },
          } as never;
        },
      },
      npcLineSource: {
        async generate(request) {
          receivedContext = request.context;
          return {
            ok: true,
            provenance: "generated",
            performance: { text: "别靠近渡口。", emotion: "afraid", usedFactIds: [] },
            diagnostics: { traceId: "npc", contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "candidate_received" },
          } as never;
        },
      },
    });

    expect(result.provenance).toBe("generated");
    expect(receivedContext).toMatchObject({
      sceneGoal: "让守门人透露渡口异常",
      requestedEmotion: "afraid",
      playerName: "Player",
      currentLocationCard: { id: "loc_a", name: "地点A" },
      npcDefinition: { id: "npc_1", description: "守着渡口、对外来者保持警惕的村民。" },
    });
  });
});

/**
 * 构建多 NPC 在场夹具：在 loc_a 放置指定 NPC（均 met=false 以确保 talk 候选存在），均已知 fact_1。
 * 供 collectNpcDialogues 三路径测试复用。
 */
function buildCollectNpcDialoguesFixtures(npcIds: readonly string[]): {
  readonly blueprint: ScenarioBlueprint;
  readonly state: GameState;
} {
  const npcNameById: Record<string, string> = {
    npc_1: "老者",
    npc_2: "商人",
    npc_3: "过客",
  };
  const npcs = npcIds.map((id) => ({
    id: asNpcId(id),
    name: npcNameById[id] ?? `NPC${id}`,
    role: "村民",
    description: `${npcNameById[id] ?? id} 的描述。`,
    locationId: asLocationId("loc_a"),
    knownFactIds: [asFactId("fact_1")],
  }));
  const blueprint = { ...buildTestBlueprint(), npcs } as unknown as ScenarioBlueprint;
  const state = {
    ...buildTestGameState(),
    npcs: npcIds.map((id) => ({
      npcId: asNpcId(id),
      locationId: asLocationId("loc_a"),
      met: false,
    })),
  } as unknown as GameState;
  return { blueprint, state };
}

describe("orchestrateNarrativeScene：Phase 14 collectNpcDialogues 三路径", () => {
  // 三测试共享的导演计划：焦点 npc_1、允许揭示 fact_1、建议 talk:npc_1 与 observe:loc_a。
  function buildDirectorSource(): DirectorSource {
    return {
      async generate() {
        return {
          ok: true,
          provenance: "generated",
          plan: {
            sceneGoal: "推进",
            tensionLevel: 2,
            focusNpcId: "npc_1",
            relevantFactIds: ["fact_1"],
            allowedRevealFactIds: ["fact_1"],
            suggestedActionKeys: ["talk:npc_1", "observe:loc_a"],
            introducedEntities: [],
            pacing: "setup",
          },
          diagnostics: { traceId: "director", contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "candidate_received" },
        } as never;
      },
    };
  }

  // 焦点 NPC npc_1 的演员 source：记录被调用 NPC 的 id，返回固定成功对白。
  function buildTrackingNpcLineSource(generateCalls: string[]): NpcLineSource {
    return {
      async generate(request) {
        const npcDef = (request.context as { npcDefinition?: { id: string } }).npcDefinition;
        generateCalls.push(npcDef?.id ?? "unknown");
        return {
          ok: true,
          provenance: "generated",
          performance: { text: "别靠近渡口。", emotion: "afraid", usedFactIds: [] },
          diagnostics: { traceId: "npc", contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "candidate_received" },
        } as never;
      },
    };
  }

  it("焦点 NPC 复用已批准的 npcLine，collectNpcDialogues 不再次调用演员 source", async () => {
    const { blueprint, state } = buildCollectNpcDialoguesFixtures(["npc_1"]);
    const generateCalls: string[] = [];
    const result = await orchestrateNarrativeScene({
      traceId: "test-collect-focus-reuse",
      blueprint,
      state,
      directorSource: buildDirectorSource(),
      sceneScriptSource: {
        async generate() {
          return {
            ok: true,
            provenance: "generated",
            script: {
              narration: "守门人盯着你的来意。",
              usedFactIds: [],
              npcInstruction: { npcId: "npc_1", speechAct: "warn", emotion: "afraid", allowedFactIds: ["fact_1"], mayLie: false },
              choices: [
                { actionKey: "talk:npc_1", label: "交谈", strategy: "试探" },
                { actionKey: "observe:loc_a", label: "观察", strategy: "查看" },
              ],
            },
            diagnostics: { traceId: "writer", contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "candidate_received" },
          } as never;
        },
      },
      npcLineSource: buildTrackingNpcLineSource(generateCalls),
    });

    expect(result.provenance).toBe("generated");
    // 焦点 NPC 仅在主流程被调用一次；collectNpcDialogues 复用 npcLine 不再调用。
    expect(generateCalls).toEqual(["npc_1"]);
    const focus = result.scene.npcDialogues?.find((d) => String(d.npcId) === "npc_1");
    expect(focus).toBeDefined();
    // 分页拼接还原 npcLine 文本（paginateSpeechText 契约：页序拼接 === trim 后原文）。
    expect(focus!.speechPages.join("")).toBe("别靠近渡口。");
  });

  it("附加 NPC 走重试生成路径，speechPages 来自演员生成文本", async () => {
    const { blueprint, state } = buildCollectNpcDialoguesFixtures(["npc_1", "npc_2"]);
    const generateCalls: string[] = [];
    const result = await orchestrateNarrativeScene({
      traceId: "test-collect-additional-generated",
      blueprint,
      state,
      directorSource: buildDirectorSource(),
      sceneScriptSource: {
        async generate() {
          return {
            ok: true,
            provenance: "generated",
            script: {
              narration: "守门人盯着你的来意。",
              usedFactIds: [],
              npcInstruction: { npcId: "npc_1", speechAct: "warn", emotion: "afraid", allowedFactIds: ["fact_1"], mayLie: false },
              additionalNpcInstructions: [
                { npcId: "npc_2", speechAct: "inform", emotion: "neutral", allowedFactIds: ["fact_1"], mayLie: false },
              ],
              choices: [
                { actionKey: "talk:npc_1", label: "交谈", strategy: "试探" },
                { actionKey: "observe:loc_a", label: "观察", strategy: "查看" },
              ],
            },
            diagnostics: { traceId: "writer", contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "candidate_received" },
          } as never;
        },
      },
      npcLineSource: buildTrackingNpcLineSource(generateCalls),
    });

    expect(result.provenance).toBe("generated");
    // 焦点 npc_1 在主流程被调用一次；附加 npc_2 经 approveSceneScript 透传后，
    // 在 collectNpcDialogues 中走 generateNpcLineTextWithRetry 重试生成路径。
    expect(generateCalls).toEqual(["npc_1", "npc_2"]);
    const additional = result.scene.npcDialogues?.find((d) => String(d.npcId) === "npc_2");
    expect(additional).toBeDefined();
    // 分页拼接还原演员生成文本（paginateSpeechText 契约：页序拼接 === trim 后原文）。
    expect(additional!.speechPages.join("")).toBe("别靠近渡口。");
  });

  it("无指令的在场 NPC 仅记录为在场（speechPages 为空），不调用演员 source", async () => {
    const { blueprint, state } = buildCollectNpcDialoguesFixtures(["npc_1", "npc_3"]);
    const generateCalls: string[] = [];
    const result = await orchestrateNarrativeScene({
      traceId: "test-collect-no-instruction",
      blueprint,
      state,
      directorSource: buildDirectorSource(),
      sceneScriptSource: {
        async generate() {
          return {
            ok: true,
            provenance: "generated",
            script: {
              narration: "守门人盯着你的来意。",
              usedFactIds: [],
              npcInstruction: { npcId: "npc_1", speechAct: "warn", emotion: "afraid", allowedFactIds: ["fact_1"], mayLie: false },
              choices: [
                { actionKey: "talk:npc_1", label: "交谈", strategy: "试探" },
                { actionKey: "observe:loc_a", label: "观察", strategy: "查看" },
              ],
            },
            diagnostics: { traceId: "writer", contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "candidate_received" },
          } as never;
        },
      },
      npcLineSource: buildTrackingNpcLineSource(generateCalls),
    });

    expect(result.provenance).toBe("generated");
    // 仅焦点 npc_1 触发演员调用；npc_3 无指令不调用。
    expect(generateCalls).toEqual(["npc_1"]);
    const extra = result.scene.npcDialogues?.find((d) => String(d.npcId) === "npc_3");
    expect(extra).toBeDefined();
    expect(extra!.speechPages).toEqual([]);
  });
});
