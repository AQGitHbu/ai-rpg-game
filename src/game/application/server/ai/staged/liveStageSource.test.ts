import { describe, expect, it } from "vitest";
import { createLiveStageSource } from "./liveStageSource";
import { PLANNING_CONTENT_RULES } from "./planningPrompt";
import { projectUnitContext } from "@/game/application/narrativeGeneration/perspectiveContext";
import { approvePlan, type ApprovedPlan } from "@/game/gameplay/rpg/narrativePlanning";
import { branchWorld, branchStory } from "@/game/gameplay/rpg/narrativePlanning/branchFixture.testutil";
import {
  makeStagedPlan,
  FIXTURE_NPC_A,
  FIXTURE_NPC_A_UNIT,
  FIXTURE_NARRATION_UNIT,
  FIXTURE_CHOICE_UNIT,
} from "@/game/domain/testing/stagedNarrativeFixture.testutil";
import type {
  StageExecution,
  StageRequest,
  StageSource,
} from "@/game/application/narrativeGeneration/stageSource";
import type { RpgAiClient } from "../rpgAiClient";
import type { AiCompletionResult } from "@ai-game/ai-transport";
import type { WorldState } from "@/game/domain/worldState";
import type { UnitOutput } from "@/game/domain/narrativeUnit";
import { asFactId, asNpcId, asLocationId, asGenerationId, type GenerationMetadata } from "@/game/domain/worldEntity";
import type { NpcEntry } from "@/game/domain/worldEntries";

// ---------------------------------------------------------------------------
// liveStageSource：每个 stage 恰好一次 client.complete；角色请求只携带
// SafeContext 的投影内容；取消信号与剩余预算原样透传；输出经 domain 解析。
// ---------------------------------------------------------------------------

function livePlan() {
  const base = makeStagedPlan();
  if (base.decision?.kind !== "ordinary") throw Error("ordinary");
  return { ...base, units: base.units.map(unit => unit.stage === "choices" ? unit : { ...unit,
    task: { intent: unit.stage === "narration" ? "describe" : "inform",
      brief: unit.stage === "narration" ? "承接现场。" : "完整回应玩家。",
      focusFactIds: [], contentFactIds: [], prerequisiteFactIds: [] } }),
    decision: { ...base.decision, options: base.decision.options.map(option => ({ ...option,
      task: { intent: option.dialogueAct, brief: "表达一个具体回应。",
        focusFactIds: [], contentFactIds: [], prerequisiteFactIds: [] } })) } };
}
it.each(["task", "brief", "contentFactIds"])("新 live 规划缺少 %s 时显式退回，不回落到笼统润色", async missing => {
  const base = livePlan();
  const plan = missing === "task" ? makeStagedPlan() : { ...base, units: base.units.map(unit => {
    if (unit.stage === "choices") return unit;
    const task = { ...unit.task } as Record<string, unknown>;
    delete task[missing];
    return { ...unit, task };
  }) };
  const { client } = recordingClient([OK_JSON(plan)]);
  const source = createLiveStageSource({ client });
  const result = await source.generate({ stage: "planning", context: { kind: "opening",
    input: { gameType: "wuxia", gameLength: "short", seed: "s" },
    generation: OPENING_GENERATION } }, { signal: new AbortController().signal, timeoutMs: 1000, audit: { purpose: "game_api", trigger: "staged_planning" } });
  expect(result).toMatchObject({ ok: false });
  expect(JSON.stringify(result)).toContain("plan_task_missing");
});

it("同场同 NPC 的多个 character 单元被退回给规划器合并", async () => {
  const base = livePlan();
  const character = base.units.find(unit => unit.stage === "character")!;
  const plan = { ...base, units: [...base.units, { ...character, key: `${character.key}_split`,
    point: { ...character.point, order: character.point.order + 1 } }] };
  const { client } = recordingClient([OK_JSON(plan)]);
  const source = createLiveStageSource({ client });
  const result = await source.generate({ stage: "planning", context: { kind: "opening",
    input: { gameType: "wuxia", gameLength: "short", seed: "s" }, generation: OPENING_GENERATION } },
  executionWith(new AbortController().signal));
  expect(JSON.stringify(result)).toContain("plan_character_response_split");
});

const SENTINEL = "SECRET_TRACKING_SEAL";
it.each(["pass", "reject", "uncertain"] as const)("披露审核独立请求并解析 %s", async verdict => {
  const { client, calls } = recordingClient([OK_JSON({ verdict })]);
  const source = createLiveStageSource({ client });
  const request = { speakerId: "npc_0", text: "官差藏身义庄。",
    claims: [{ factId: "fact_new", text: "官差藏身义庄。", certainty: "known" as const, audienceIds: ["player_0"] }] };
  const result = await source.reviewDisclosure!(request, { signal: new AbortController().signal,
    timeoutMs: 1000, audit: { purpose: "game_api", trigger: "disclosure_review" } });
  expect(result).toEqual({ ok: true, verdict });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.role).toBe("disclosure_review");
  expect(calls[0]!.messages).toHaveLength(1);
  expect(calls[0]!.messages[0]!.content).toContain(JSON.stringify(request));
  expect(calls[0]!.messages[0]!.content).not.toContain(SENTINEL);
});
const FACT_PUB = "fact_pub";
it.each([{ verdict: ["pass"] }, { verdict: "pass", extra: "text" }, { verdict: "yes" }])(
  "非法审核响应不能冒充 pass：%j", async body => {
    const { client } = recordingClient([OK_JSON(body)]);
    const source = createLiveStageSource({ client });
    expect(await source.reviewDisclosure!({ speakerId: "npc_0", text: "对白", claims: [] },
      { signal: new AbortController().signal, timeoutMs: 1000,
        audit: { purpose: "game_api", trigger: "disclosure_review" } })).toMatchObject({ ok: false });
  });
const FACT_SECRET = "fact_secret";

/** opening planning 的结构编译元数据：prompt 组装只经此读取 generation/seed。 */
const OPENING_GENERATION: GenerationMetadata = {
  generationId: asGenerationId("gen_stage_test"),
  seed: "s",
  templateVersion: "v2",
  inputDigest: "",
  gameType: "wuxia",
};

type RecordedCall = {
  readonly role: string;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly auditContext: unknown;
  readonly overrides: Readonly<{ signal?: AbortSignal; timeoutMs?: number }> | undefined;
};

function recordingClient(scripted: readonly AiCompletionResult[]): {
  readonly client: RpgAiClient;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let index = 0;
  const client = {
    policy: () => ({
      thinking: "off" as const,
      timeoutMs: 1_000,
      jsonMode: "prompt_only" as const,
      maxAttempts: 1,
    }),
    async complete(
      role: string,
      messages: readonly { readonly role: string; readonly content: string }[],
      auditContext: unknown,
      overrides?: { signal?: AbortSignal; timeoutMs?: number },
    ): Promise<AiCompletionResult> {
      calls.push({ role, messages, auditContext, overrides });
      const result = scripted[index];
      index += 1;
      if (result === undefined) throw new Error(`no scripted result for call ${index}`);
      return result;
    },
  };
  return { client: client as unknown as RpgAiClient, calls };
}

function npcEntry(id: string): NpcEntry {
  return {
    id: asNpcId(id),
    name: id === FIXTURE_NPC_A ? "老陈" : "船夫",
    role: "知情者",
    description: "守着渡口的人",
    locationId: asLocationId("loc_a"),
    isCompanion: false,
    tags: [],
    met: true,
    memory: {
      npcId: asNpcId(id),
      knownFactIds: [],
      hiddenFactIds: [],
      interactionHistory: [],
      relationship: { affinity: 0 },
      emotion: "neutral",
      goals: [],
    },
  };
}

function personaWorld(): WorldState {
  return branchWorld({
    worldFacts: [
      { factId: asFactId(FACT_PUB), text: "渡口昨夜有灯火", source: "generated", discovered: true },
      { factId: asFactId(FACT_SECRET), text: `老陈私藏${SENTINEL}密信`, source: "generated", discovered: false },
    ],
    npcs: [npcEntry(FIXTURE_NPC_A), npcEntry("npc_1")],
  });
}

function approvedPlan(): ApprovedPlan {
  const proposal = makeStagedPlan();
  if (proposal.decision?.kind !== "ordinary") throw new Error("ordinary fixture required");
  const options = proposal.decision.options;
  const result = approvePlan({
    kind: "decision",
    proposal: { ...proposal, decision: { ...proposal.decision, options: [
      { ...options[0], target: { kind: "visit_location", locationId: "loc_b" } },
      { ...options[1], target: { kind: "visit_location", locationId: "loc_c" } },
    ] } },
    world: personaWorld(),
    story: branchStory(),
  });
  if (!result.ok) throw new Error(`fixture plan rejected: ${result.code}`);
  return result.value;
}

function approvedOutputs(plan: ApprovedPlan): ReadonlyMap<string, UnitOutput> {
  const approved = new Map<string, UnitOutput>();
  for (const unit of plan.units) {
    const output: UnitOutput = unit.stage === "narration"
      ? { stage: "narration", parts: [{ text: "风从门缝里挤进来。", facts: [], evidence: [], beatIds: [] }], actionKeys: [] }
      : unit.stage === "character"
        ? {
            stage: "character",
            speakerId: unit.speakerId ?? "",
            parts: [{ text: "先坐吧。", facts: [], evidence: [], beatIds: [] }],
            emotion: "neutral",
            actions: [],
            answeredBeatIds: [],
          }
        : {
            stage: "choices",
            labels: [
              { candidateId: "cand_route", label: "我跟你去北岭看看。" },
              { candidateId: "cand_alt", label: "我要当面问清楚。" },
            ],
          };
    approved.set(unit.key, output);
  }
  return approved;
}

function contextFor(plan: ApprovedPlan, key: string) {
  const unit = plan.units.find((candidate) => candidate.key === key);
  if (unit === undefined) throw new Error(`fixture missing unit ${key}`);
  const projected = projectUnitContext({ plan, unit, approved: approvedOutputs(plan) });
  if (!projected.ok) throw new Error(`projection failed: ${projected.code}`);
  return projected.value;
}

const AUDIT = { purpose: "narrative_bundle_generation" as const, trigger: "staged_test" };

function executionWith(signal: AbortSignal, timeoutMs = 4321): StageExecution {
  return { signal, timeoutMs, audit: AUDIT };
}

const OK_JSON = (value: unknown): AiCompletionResult => ({
  ok: true,
  content: JSON.stringify(value),
  latencyMs: 1,
});

const VALID_NARRATION = {
  stage: "narration",
  parts: [{ text: "烛火偏了一下。", facts: [], evidence: [], beatIds: [] }],
  actionKeys: [],
};

const VALID_CHARACTER = {
  stage: "character",
  speakerId: FIXTURE_NPC_A,
  parts: [{ text: "我只说我知道的。", facts: [], evidence: [], beatIds: [] }],
  emotion: "neutral",
  actions: [],
  answeredBeatIds: [],
};

const VALID_CHOICES = {
  stage: "choices",
  labels: [
    { candidateId: "cand_route", label: "我跟你去北岭看看。" },
    { candidateId: "cand_alt", label: "我要当面问清楚。" },
  ],
};

function fourStageRequests(): readonly StageRequest[] {
  const plan = approvedPlan();
  return [
    { stage: "planning", context: { kind: "opening", generation: OPENING_GENERATION, input: { gameType: "wuxia", seed: "s", gameLength: "short" } } },
    { stage: "narration", context: contextFor(plan, FIXTURE_NARRATION_UNIT) },
    { stage: "character", context: contextFor(plan, FIXTURE_NPC_A_UNIT) },
    { stage: "choices", context: contextFor(plan, FIXTURE_CHOICE_UNIT) },
  ];
}

describe("createLiveStageSource", () => {
  it("四个 stage 各调用一次 complete，role 顺序为 planning/narration/character/choices", async () => {
    const { client, calls } = recordingClient([
      OK_JSON(livePlan()),
      OK_JSON(VALID_NARRATION),
      OK_JSON(VALID_CHARACTER),
      OK_JSON(VALID_CHOICES),
    ]);
    const source: StageSource = createLiveStageSource({ client });
    const controller = new AbortController();
    for (const request of fourStageRequests()) {
      const result = await source.generate(request, executionWith(controller.signal));
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.stage).toBe(request.stage);
    }
    expect(calls.map((call) => call.role)).toEqual(["planning", "narration", "character", "choices"]);
    expect(calls.every((call) => call.messages).valueOf()).toBe(true);
    expect(calls[0]!.messages[0]).toEqual({ role: "system", content: PLANNING_CONTENT_RULES });
    expect(calls.slice(1).every(call => call.messages[0]?.role === "system"
      && call.messages[0].content.includes("你不从这些资料中选取新内容"))).toBe(true);
    expect(calls.every((call) => call.auditContext === AUDIT)).toBe(true);
  });

  it("角色请求的消息不携带秘密，也不含 planning 阶段内容", async () => {
    const { client, calls } = recordingClient([
      OK_JSON(livePlan()),
      OK_JSON(VALID_NARRATION),
      OK_JSON(VALID_CHARACTER),
      OK_JSON(VALID_CHOICES),
    ]);
    const source = createLiveStageSource({ client });
    const controller = new AbortController();
    for (const request of fourStageRequests()) {
      await source.generate(request, executionWith(controller.signal));
    }
    const characterCall = calls[2]!;
    const characterText = characterCall.messages.map((message) => message.content).join("\n");
    expect(characterText).not.toContain(SENTINEL);
    expect(characterText).not.toContain("facts_secret_key");
    // 每个 stage 独立 messages：角色请求不携带 planning 骨架内容。
    expect(characterText).not.toContain("terminal");
  });

  it("choice prompt 只返回两条玩家直接说出的对白", async () => {
    const { client, calls } = recordingClient([
      OK_JSON(livePlan()),
      OK_JSON(VALID_NARRATION),
      OK_JSON(VALID_CHARACTER),
      OK_JSON(VALID_CHOICES),
    ]);
    const source = createLiveStageSource({ client });
    const controller = new AbortController();
    for (const request of fourStageRequests()) {
      await source.generate(request, executionWith(controller.signal));
    }
    const choiceText = calls[3]!.messages.map((message) => message.content).join("\n");
    expect(choiceText).toContain("只返回玩家直接说出的对白");
    expect(choiceText).toContain("cand_route");
    expect(choiceText).toContain("cand_alt");
  });

  it("AbortSignal 与剩余 timeoutMs 原样透传给 client", async () => {
    const { client, calls } = recordingClient([
      OK_JSON(livePlan()),
      OK_JSON(VALID_NARRATION),
      OK_JSON(VALID_CHARACTER),
      OK_JSON(VALID_CHOICES),
    ]);
    const source = createLiveStageSource({ client });
    const controller = new AbortController();
    for (const request of fourStageRequests()) {
      await source.generate(request, executionWith(controller.signal, 777));
    }
    for (const call of calls) {
      expect(call.overrides?.signal).toBe(controller.signal);
      expect(call.overrides?.timeoutMs).toBe(777);
    }
  });

  it("planning 输出含未知字段时按 invalid_schema 拒绝并保留稳定拒绝码", async () => {
    const bogusPlan = { ...makeStagedPlan(), bogus_key: true };
    const { client } = recordingClient([OK_JSON(bogusPlan)]);
    const source = createLiveStageSource({ client });
    const controller = new AbortController();
    const result = await source.generate(
      { stage: "planning", context: { kind: "opening", generation: OPENING_GENERATION, input: { gameType: "wuxia", seed: "s", gameLength: "short" } } },
      executionWith(controller.signal),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("AI_RESPONSE_INVALID");
    expect(result.repairReason).toBe("invalid_schema");
    expect(result.repairDetail).toBe("plan_unknown_key");
  });

  it("provider 传输失败按既有分类映射为 AI_CALL_FAILED", async () => {
    const { client } = recordingClient([
      { ok: false, code: "timeout", retryable: true, latencyMs: 5 },
    ]);
    const source = createLiveStageSource({ client });
    const controller = new AbortController();
    const result = await source.generate(
      { stage: "narration", context: contextFor(approvedPlan(), FIXTURE_NARRATION_UNIT) },
      executionWith(controller.signal),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("AI_CALL_FAILED");
    expect(result.failure.phase).toBe("scene");
    expect(result.repairReason).toBe("provider_failure");
    expect(result.repairDetail).toContain("code=timeout");
  });

  it("把思考耗尽导致的空最终内容写成可执行的下一轮修复反馈", async () => {
    const { client } = recordingClient([{
      ok: false,
      code: "empty_response",
      retryable: false,
      latencyMs: 5,
      finishReason: "length",
      reasoningTokens: 6_000,
      hasReasoningContent: true,
    } as AiCompletionResult]);
    const source = createLiveStageSource({ client });
    const result = await source.generate(
      { stage: "planning", context: { kind: "opening", generation: OPENING_GENERATION,
        input: { gameType: "wuxia", seed: "s", gameLength: "short" } } },
      executionWith(new AbortController().signal),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("AI_CALL_FAILED");
    expect(result.repairReason).toBe("empty_response");
    expect(result.repairDetail).toContain("finishReason=length");
    expect(result.repairDetail).toContain("reasoningTokens=6000");
    expect(result.repairDetail).toContain("未返回最终 JSON");
  });

  it("输出 stage 与请求不一致时拒绝", async () => {
    const { client } = recordingClient([OK_JSON(VALID_CHARACTER)]);
    const source = createLiveStageSource({ client });
    const controller = new AbortController();
    const result = await source.generate(
      { stage: "narration", context: contextFor(approvedPlan(), FIXTURE_NARRATION_UNIT) },
      executionWith(controller.signal),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("AI_RESPONSE_INVALID");
    expect(result.repairDetail).toBe("unit_output_stage_mismatch");
  });
});
