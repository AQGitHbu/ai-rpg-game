import { describe, expect, it } from "vitest";
import { asGenerationId } from "@/game/domain/worldEntity";
import { DIALOGUE_ACTS } from "@/game/domain/action";
import {
  buildPlanningPrompt,
  PLANNING_CONTENT_RULES,
  renderPlanProposalContract,
  PLANNING_BEAT_KINDS,
  PLANNING_TRIGGER_KINDS,
  PLANNING_ROUTE_TARGET_KINDS,
  PLANNING_TOPIC_KINDS,
} from "./planningPrompt";
import { buildNarrationPrompt } from "./narrationPrompt";
import { buildCharacterPrompt } from "./characterPrompt";
import { buildChoicePrompt } from "./choicePrompt";
import { expressionBoundary } from "./expressionBoundary";
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
import type { AiContentRepair } from "@/game/application/aiGenerationRetry";
import type { WorldState } from "@/game/domain/worldState";
import type { UnitOutput } from "@/game/domain/narrativeUnit";
import { asEventId, asNarrativeJobId, asTurnId } from "@/game/domain/events";
import { asFactId, asLocationId, asNpcId } from "@/game/domain/worldEntity";
import type { NpcEntry } from "@/game/domain/worldEntries";
import { createPendingNarrativeJob, type PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";

it("三个表达器不把措辞加工变成新经历、往日对白或现场证据", () => {
  const plan = approvedPlan();
  for (const stage of ["narration", "character", "choices"] as const) {
    const unit = plan.units.find(unit => unit.stage === stage)!;
    const safe = projectUnitContext({ plan, unit, approved: approvedOutputs(plan) });
    if (!safe.ok) throw Error(safe.code);
    const prompt = stage === "narration" ? buildNarrationPrompt(safe.value)
      : stage === "character" ? buildCharacterPrompt(safe.value) : buildChoicePrompt(safe.value);
    expect(prompt).toContain(stage === "narration" ? "禁止把口述变成目击"
      : stage === "character" ? "不为解释不知道再编一段经过" : "不得新增玩家经历或能力");
    expect(prompt).toContain(expressionBoundary());
  }
});

it("选项身份直接来自批准焦点，不复制前文中的玩家称呼", () => {
  const plan = approvedPlan();
  const safe = contextFor(plan, FIXTURE_CHOICE_UNIT);
  expect(safe.dialogue?.speakerName).toBe(plan.world.player.name);
  expect(safe.dialogue?.addresseeId).toBe(plan.choiceExpression?.npcId);
  expect(safe.dialogue?.addresseeRole).toBe("知情者");
  expect(buildChoicePrompt(safe)).toContain(JSON.stringify(safe.dialogue));
  expect(buildChoicePrompt(safe)).toContain("前文 NPC 对玩家的称呼不能照搬");
});

it("完整内容和已说对白进入润色 prompt，旧候选不再作为表达模板", () => {
  const plan = approvedPlan();
  const brief = "先承认不知道告示的发布衙门，再回应玩家愿意帮忙留意陌生刀客；不重讲镇子不太平。";
  const history = "我只知道客栈近日早早落闩。";
  const character = { ...contextFor(plan, FIXTURE_NPC_A_UNIT), taskInstruction: brief, previousReply: history };
  expect(buildCharacterPrompt(character)).toContain(brief);
  expect(buildCharacterPrompt(character)).toContain(history);
  expect(buildNarrationPrompt({ ...contextFor(plan, FIXTURE_NARRATION_UNIT), previousReply: history })).toContain(history);
  const choices = { ...contextFor(plan, FIXTURE_CHOICE_UNIT), previousReply: history,
    previousChoices: ["OLD_CHOICE_TEMPLATE"], options: contextFor(plan, FIXTURE_CHOICE_UNIT).options.map(option => ({
      ...option, publicIntent: { ...option.publicIntent, text: brief },
    })) };
  expect(buildChoicePrompt(choices)).toContain(brief);
  expect(buildChoicePrompt(choices)).toContain(history);
  expect(buildChoicePrompt(choices)).not.toContain("OLD_CHOICE_TEMPLATE");
  for (const prompt of [buildCharacterPrompt(character), buildChoicePrompt(choices)]) {
    expect(prompt.indexOf(brief)).toBeGreaterThan(prompt.indexOf(history));
  }
});

// ---------------------------------------------------------------------------
// 四类 staged prompt 的内容契约：设定风格不丢失、公开/私密分区、SafeContext
// 投影进入对应 prompt；choice prompt 只返回两条对白 label。
// ---------------------------------------------------------------------------

const FACT_PUB = "fact_pub";
const FACT_SECRET = "fact_secret";

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
      { factId: asFactId(FACT_SECRET), text: "老陈私藏密信", source: "generated", discovered: false },
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

const REPAIR: AiContentRepair = { attempt: 2, reason: "invalid_schema", rejectionCode: "plan_unknown_key" };

it("规划器接收隔轮未知与已选完整意图，不能把历史措辞当作新答案", () => {
  const prompt = buildPlanningPrompt({ kind: "decision", world: personaWorld(), story: branchStory(),
    job: makeStagedJob(), dialogueHistory: [{ previousReply: "我不知道告示是哪个衙门发布的。",
      previousChoices: ["我帮你留意陌生刀客。"], selectedDialogue: { dialogueAct: "support", task: {
        intent: "support", brief: "帮老人留意刀客行踪，不承诺独自追捕。", focusFactIds: [],
        contentFactIds: [], prerequisiteFactIds: [],
      } } }] });
  expect(prompt).toContain("我不知道告示是哪个衙门发布的。");
  expect(prompt).toContain("帮老人留意刀客行踪，不承诺独自追捕。");
  expect(PLANNING_CONTENT_RULES).toContain("历史对白只供衔接，不是事实依据");
  expect(PLANNING_CONTENT_RULES).toContain("已问过且答称不知道的问题不再问");
  expect(prompt).toContain("已选、未选都已展示");
  expect(prompt).not.toContain("以及哪些背景不必复述");
});

function makeStagedJob(): PendingNarrativeJob {
  const result = createPendingNarrativeJob({
    jobId: asNarrativeJobId("job-1"),
    turnId: asTurnId("turn-1"),
    actionId: "action-1",
    expectedRevision: 41,
    turnNumber: 3,
    actionSummary: { kind: "talk", npcId: asNpcId(FIXTURE_NPC_A) },
    utterance: "我想打听渡口的事",
    resolvedEvent: {
      actionId: "action-1",
      status: "success",
      eventKind: "observe",
      facts: [],
      stateChanges: [],
      costs: [],
      rewards: [],
      triggeredEvents: [],
      rejectedEffects: [],
    },
    domainEventIds: [asEventId("turn-1:event-12")],
    focusNpcId: asNpcId(FIXTURE_NPC_A),
    requestedAt: "2026-09-09T08:00:00.000Z",
    objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" },
    mandatoryBeats: [{
      beatId: "force_unlock",
      kind: "fact_discovered",
      subjectIds: [FACT_PUB],
      instruction: "让玩家知道渡口昨夜有灯火",
    }],
    generationKind: "npc_fixed_choice",
    sceneRequestKind: "npc_response",
  });
  if (!result.ok) throw new Error(`job fixture invalid: ${JSON.stringify(result)}`);
  return result.job;
}

describe("buildPlanningPrompt", () => {
  it("固定选项将已选 label 明确作为本轮玩家原话，自由输入仍优先", () => {
    const context = { kind: "decision" as const, world: personaWorld(), story: branchStory(),
      job: { ...makeStagedJob(), utterance: undefined, selectedDialogue: { dialogueAct: "challenge" as const, topic: { kind: "general" as const }, label: "你凭什么信它是真的？" } } };
    expect(buildPlanningPrompt(context)).toContain("- 玩家原话：你凭什么信它是真的？");
    expect(buildPlanningPrompt({ ...context, job: { ...context.job, utterance: "我想核实发布者。" } })).toContain("- 玩家原话：我想核实发布者。");
  });

  it("下一幕不能把增量前的 ending 当权威图，保留玩家已选语义", () => {
    const story = branchStory();
    const prompt = buildPlanningPrompt({ kind: "decision", world: personaWorld(),
      story: { ...story, evolution: { ...story.evolution, status: "needs_next_act" } },
      job: { ...makeStagedJob(), selectedDialogue: { dialogueAct: "challenge", topic: { kind: "general" }, label: "我不认同。" } },
    });
    const graph = JSON.parse(prompt.split("# 服务端场景骨架\n")[1]!.split("\n")[0]!);
    expect(graph.graphStatus).toBe("pending_world_delta");
    expect(graph).not.toHaveProperty("terminal");
    expect(graph).not.toHaveProperty("decisionPoint");
    expect(graph.dynamicIds.location).toBe(`loc_dyn_${story.evolution.nextLocationOrdinal}`);
    expect(prompt).toContain('"dialogueAct":"challenge"');
    expect(prompt).toContain("我不认同。");
  });

  it("普通开局明确分工且不强制新地点路线", () => {
    const prompt = buildPlanningPrompt({ kind: "opening", input: { gameType: "wuxia", gameLength: "short", seed: "scope" },
      generation: { generationId: asGenerationId("gen_scope"), seed: "scope", templateVersion: "v2", inputDigest: "", gameType: "wuxia" } });
    expect(prompt).toContain("target/deferredLocation 都为 null");
    expect(prompt).toContain("三个表达器只负责表达");
    expect(prompt).not.toContain("开局普通选项必须各带一个不同的 deferredLocation");
  });

  it("opening 规划保留玩家设定风格：profile、性格标签与故事开端不丢失", () => {
    const prompt = buildPlanningPrompt({
      kind: "opening",
      generation: {
        generationId: asGenerationId("gen_prompt_test"),
        seed: "seed-1",
        templateVersion: "v2",
        inputDigest: "",
        gameType: "wuxia",
      },
      input: {
        gameType: "wuxia",
        seed: "seed-1",
        gameLength: "short",
        setup: {
          characterName: "沈砚",
          characterIdentity: "游侠",
          characterProfile: "曾押镖三年，熟悉山路",
          personalityTags: ["冷静", "寡言"],
          worldPremise: "北岭货运断绝",
          storyOpening: "渡口有人等你",
          narrativeStyle: "concise",
          contentIntensity: "normal",
        },
        attempt: 1,
      },
    });
    expect(prompt).toContain("沈砚");
    expect(prompt).toContain("曾押镖三年，熟悉山路");
    expect(prompt).toContain("冷静");
    expect(prompt).toContain("寡言");
    expect(prompt).toContain("渡口有人等你");
    expect(prompt).toContain("39");
  });

  it("opening 规划渲染内容修复反馈", () => {
    const prompt = buildPlanningPrompt({
      kind: "opening",
      generation: {
        generationId: asGenerationId("gen_prompt_test"),
        seed: "s",
        templateVersion: "v2",
        inputDigest: "",
        gameType: "wuxia",
      },
      input: { gameType: "wuxia", seed: "s", gameLength: "short" },
    }, REPAIR);
    expect(prompt).toContain("修复序号=2");
    expect(prompt).toContain("plan_unknown_key");
  });

  it("decision 规划分区公开与私密事实，并携带已选 branch 与必选节拍", () => {
    const plan = approvedPlan();
    const prompt = buildPlanningPrompt({
      kind: "decision",
      world: plan.world,
      story: plan.story,
      job: makeStagedJob(),
    });
    expect(prompt).toContain("公开事实");
    expect(prompt).toContain("私密事实");
    expect(prompt).toContain("渡口昨夜有灯火");
    expect(prompt).toContain("npc_0");
    expect(prompt).toContain("force_unlock");
  });
});

// ---------------------------------------------------------------------------
// Task 12 Step 4：prompt 与 parser 的防漂移断言。
//
// 真实 smoke 暴露过一类静默缺陷：planning prompt 只声明顶层 8 键，模型按直觉
// 产出 type/dependsOn/裸字符串 point/null next 而全数被 parsePlanProposal 拒绝，
// 而所有离线用例都喂手工 fixture，永远测不出来。下面把「契约必须覆盖 parser
// 白名单」固化成断言，schema 改了而 prompt 没改会直接失败。
// ---------------------------------------------------------------------------

describe("buildPlanningPrompt 契约完整性", () => {
  function openingPrompt(): string {
    return buildPlanningPrompt({
      kind: "opening",
      generation: {
        generationId: asGenerationId("gen_contract_test"),
        seed: "seed-1",
        templateVersion: "v2",
        inputDigest: "",
        gameType: "urban",
      },
      input: { gameType: "urban", seed: "seed-1", gameLength: "short" },
    });
  }

  function decisionPrompt(): string {
    const plan = approvedPlan();
    return buildPlanningPrompt({
      kind: "decision",
      world: plan.world,
      story: plan.story,
      job: makeStagedJob(),
    });
  }

  it("连续对白的可选 atmosphere 不作为必须表达的节拍", () => {
    const plan = approvedPlan();
    const prompt = buildPlanningPrompt({ kind: "decision", world: plan.world, story: plan.story,
      job: { ...makeStagedJob(), objectiveTransition: { before: null, completed: [], after: { questId: plan.world.quests[0]!.id, objectiveIndex: 0, label: "继续对白" }, mode: "unchanged" },
        mandatoryBeats: [{ beatId: "atmosphere", kind: "atmosphere", subjectIds: [], instruction: "可选氛围" }] } }, REPAIR);
    expect(prompt).toContain("本轮没有必选节拍");
    expect(prompt).toContain("三个单元的 requiredBeats 均为 []");
    expect(prompt).toContain("plan_unknown_key");
    expect(prompt).toContain("fact_pub");
    const graph = JSON.parse(prompt.split("# 服务端场景骨架\n")[1]!.split("\n")[0]!);
    expect(graph.decisionNpcId).toBe(FIXTURE_NPC_A);
    expect(graph.candidateIds).toEqual(["current_scene_choice_1", "current_scene_choice_2"]);
  });

  it("开局和续接观察均使用权威玩家实体 player_0", () => {
    for (const prompt of [openingPrompt(), decisionPrompt()]) {
      expect(prompt).toContain('玩家必须写 "player_0"');
      expect(prompt).not.toContain('玩家写 "player"');
    }
  });

  it("渲染 PlanProposal 顶层 8 键与全部子结构段", () => {
    const prompt = decisionPrompt();
    for (const key of ["opening", "worldDelta", "steps", "units", "observations", "actions", "decision", "terminal"]) {
      expect(prompt).toContain(key);
    }
    // 题名必须出现，否则模型不知道有这段契约。
    for (const section of ["## steps[]", "## units[]", "## observations[]", "## actions[]", "## decision", "## terminal"]) {
      expect(prompt).toContain(section);
    }
  });

  it("units 契约用 stage/dependencies 并显式排除 type/dependsOn", () => {
    const prompt = decisionPrompt();
    expect(prompt).toContain("stage");
    expect(prompt).toContain("dependencies");
    // 反向提示：模型凭直觉会写 type / dependsOn，契约必须点名禁止。
    expect(prompt).toContain("不是 type");
    expect(prompt).toContain("不是 dependsOn");
  });

  it("新 live task 要求完整 brief、正文事实分层与单次 NPC 回应", () => {
    const prompt = decisionPrompt();
    expect(prompt).toContain('"brief"');
    expect(prompt).toContain('"contentFactIds"');
    expect(prompt).toContain("focusFactIds 是本任务可用的话题背景范围");
    expect(prompt).toContain("答应帮老人留意刀客的行踪");
    expect(prompt).toContain("询问告示由哪个衙门发布");
    expect(prompt).toContain("同一 stepKey 的同一 NPC 必须恰好用一个 character 单元");
    expect(prompt).toContain("全部合并进同场该 NPC 的唯一 character 单元");
    expect(prompt).not.toContain("可分配给同场该 NPC 的多个单元");
    expect(prompt).toContain("unknown 不要求复述问题背景");
  });

  it("列出 parseTrigger 的全部 trigger kind", () => {
    const prompt = decisionPrompt();
    for (const kind of PLANNING_TRIGGER_KINDS) {
      expect(prompt).toContain(kind);
    }
    // investigate 用 factId 而非 objectId —— 这是模型必错的字段。
    expect(prompt).toContain("不是 objectId");
  });

  it("列出 parseSafeBeat 的全部 beat kind 与 evidence 对象形状", () => {
    const prompt = decisionPrompt();
    for (const kind of PLANNING_BEAT_KINDS) {
      expect(prompt).toContain(kind);
    }
    // evidence 必须是对象数组，模型必错。
    expect(prompt).toContain("committed");
    expect(prompt).toContain("conditional");
    expect(prompt).toContain("对象数组");
  });

  it("列出 DIALOGUE_ACTS 全量并声明 publicIntent 是句段对象", () => {
    const prompt = decisionPrompt();
    for (const act of DIALOGUE_ACTS) {
      expect(prompt).toContain(act);
    }
    expect(prompt).toContain("不是字符串");
    // publicIntent.facts 是 FactUse 对象数组，不是裸键数组。
    expect(prompt).toContain("FactUse 对象数组");
    expect(prompt).toContain("绝不可写成裸键数组");
    expect(prompt).toContain('"certainty": "known" 或 "suspected"');
    for (const key of PLANNING_ROUTE_TARGET_KINDS) {
      expect(prompt).toContain(key);
    }
    for (const kind of PLANNING_TOPIC_KINDS) {
      expect(prompt).toContain(kind);
    }
  });

  it("steps.next 声明为数组而非 null", () => {
    const prompt = decisionPrompt();
    expect(prompt).toContain("必须是**数组**");
    expect(prompt).toContain("终点步写 []");
  });

  it("observations 引用约束完整覆盖 checkUnitGraph 的 observation_without_source 判定", () => {
    // 真实 smoke 曾因缺这条契约而失败：模型写的 observation.audienceIds 只有 player，
    // 但引用它的 character 单元 speakerId 是 NPC → speakerId 不在 audienceIds 里 → 拒绝。
    const prompt = decisionPrompt();
    expect(prompt).toContain("引用观察的硬性约束");
    expect(prompt).toContain("与本单元 point.stepKey 完全相同");
    expect(prompt).toContain("≤ 本单元 point.order");
    expect(prompt).toContain("必须出现在该观察的 audienceIds 里");
    expect(prompt).toContain("observation_without_source");
  });

  it("observations 引用必须同 step，且 choices 单元不得引用观察", () => {
    // 真实 smoke 第二条 observation_without_source：choices 单元（step=s_decision）引用了
    // 前一个场景（step=s_encounter）的观察 → 规则②要求 stepKey 完全相同 → 拒绝。
    const prompt = decisionPrompt();
    expect(prompt).toContain("跨 step 引用必然失败");
    expect(prompt).toContain("跨 step 引用一律被拒");
    // choices 单元不产出证据，引用观察纯属多余且必然失败。
    expect(prompt).toContain('stage="choices" 的单元必须写 []');
    expect(prompt).toContain('stage="choices" 的单元 requiredObservationKeys 必须为空数组');
  });

  it("unit 图结构性约束在 prompt 中声明（决策唯一、决策后无单元、依赖无环）", () => {
    const prompt = decisionPrompt();
    expect(prompt).toContain("不得悬空");
    expect(prompt).toContain("不得成环");
    expect(prompt).toContain("choices 之后不得再排单元");
    expect(prompt).toContain("恰好一个 choices 单元承接 decision");
  });

  it("units[] 契约段直接声明「choices 单元只能有 1 个」（缺陷 15）", () => {
    // 真实 smoke：模型给每个场景都配了 choices 单元，产出 2 个 choices，而 decision
    // 只声明 1 个 → checkUnitGraph 判 decision_unit_mismatch。规则此前只写在预算段，
    // 离模型实际写 units 的位置太远。现在在 units[] 契约段就地声明并解释原因。
    const prompt = decisionPrompt();
    expect(prompt).toContain("的单元只能有 1 个");
    expect(prompt).toContain("decision_unit_mismatch");
    // 必须明确「线性场景没有 choices」，否则模型仍会按场景直觉补 choices。
    expect(prompt).toContain("线性场景（非决策点）");
    expect(prompt).toContain("没有");
  });

  it("opening 链路渲染 OpeningGenerationCandidate 精确契约，决策链路不渲染", () => {
    const opening = openingPrompt();
    for (const key of ["summary", "tone", "themes", "publicFacts", "storyContract", "endingDirections", "npcConnection", "responses"]) {
      expect(opening).toContain(key);
    }
    expect(opening).toContain('scale 固定为 "town"');
    expect(opening).toContain("talk_to_opening_npc");
    // 决策链路不得出现 opening 契约（opening 必须为 null）。
    const decision = decisionPrompt();
    expect(decision).not.toContain("# opening 精确契约");
    expect(decision).toContain("# PlanProposal 精确契约");
  });

  it("targetActs 随 gameLength 变化", () => {
    const short = buildPlanningPrompt({
      kind: "opening",
      generation: { generationId: asGenerationId("g"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "urban" },
      input: { gameType: "urban", seed: "s", gameLength: "short" },
    });
    const medium = buildPlanningPrompt({
      kind: "opening",
      generation: { generationId: asGenerationId("g"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "urban" },
      input: { gameType: "urban", seed: "s", gameLength: "medium" },
    });
    expect(short).toContain("固定为 3");
    expect(medium).toContain("固定为 5");
  });

  it("opening 链路声明服务端固定实体 id，禁止模型自造", () => {
    // 真实 smoke 失败：prompt 不含任何实体 id，模型凭 opening.npc.name 自造 "lu_ping"，
    // 而编译层固定用 npc_0 → approveUnit/投影阶段 unknown_speaker。
    const opening = openingPrompt();
    expect(opening).toContain("实体 id 是服务端固定分配的");
    expect(opening).toContain("npc_0");
    expect(opening).toContain("player_0");
    // 公开事实的实体 id 按 publicFacts 下标分配：publicFacts[0].key → fact_0。
    expect(opening).toContain("fact_0");
    expect(opening).toContain("数组下标");
    // taskFactIds / beat.factIds 引用的是实体 id，不是语义 key。
    expect(opening).toContain("事实**实体 id**");
  });

  it("worldDelta 契约覆盖 parseWorldDeltaProposal 的全部顶层键与空提案拒绝", () => {
    // narrativePlan 已把 worldDelta 委托给 parseWorldDeltaProposal 逐字段解析，
    // prompt 不给出完整形状时模型只能靠猜，坏形状直接 plan_world_delta_invalid。
    const prompt = renderPlanProposalContract({ kind: "decision", world: personaWorld(), story: branchStory(), job: makeStagedJob() });
    for (const key of [
      "beatSummary", "newLocation", "newNpc", "newItem", "newEnemy",
      "newFact", "nextMainQuest", "endingPair",
    ]) {
      expect(prompt).toContain(key);
    }
    expect(prompt).toContain("## worldDelta");
    // 只有 beatSummary 的空提案被 parseWorldDeltaProposal 判 null。
    expect(prompt).toContain("plan_world_delta_invalid");
    expect(prompt).toContain("至少包含一个实体变化字段");
  });

  it("无需世界增量的普通对白只提供相关契约，场景骨架不重复", () => {
    const prompt = decisionPrompt();
    expect(prompt).toContain("本次必须为 null；只规划当前规则要求的表达");
    expect(prompt).not.toContain("7 键全部必填");
    expect(prompt).not.toContain("# 世界演化与衔接");
    expect(prompt.match(/# 服务端场景骨架/g)).toHaveLength(1);
    for (const stage of ["narration", "character", "choices"]) expect(prompt).toContain(stage);
  });

  it("worldDelta 子结构契约逐字段对齐 parser（newNpc 7 键全必填、锚点/目标/关系种子形状）", () => {
    const prompt = renderPlanProposalContract({ kind: "decision", world: personaWorld(), story: branchStory(), job: makeStagedJob() });
    // newNpc 7 键必须全部出现且声明必填（parser 用 hasExactKeys）。
    for (const key of ["locationRef", "anchors", "goals", "relationshipSeeds"]) {
      expect(prompt).toContain(key);
    }
    expect(prompt).toContain("7 键全部必填");
    for (const key of ["selfConcept", "values", "speechStyle", "capabilityBoundaries", "taboos"]) {
      expect(prompt).toContain(key);
    }
    for (const key of ["horizon", "priority", "targetNpcId", "stance"]) {
      expect(prompt).toContain(key);
    }
    // locationRef 两种形态：NPC 是对象，物品/敌人是字符串——模型必错的分叉。
    expect(prompt).toContain('{"kind":"existing","id"');
    expect(prompt).toContain('{"kind":"new_location"}');
    expect(prompt).toContain('"current" | "new_location"');
  });

  it("worldDelta 调查方式契约对齐 parseFactInvestigationApproaches", () => {
    const prompt = renderPlanProposalContract({ kind: "decision", world: personaWorld(), story: branchStory(), job: makeStagedJob() });
    for (const key of ["approachId", "evidenceQuality", "tensionDelta", "investigationApproaches"]) {
      expect(prompt).toContain(key);
    }
    expect(prompt).toContain("clean");
    expect(prompt).toContain("noisy");
    // 防泄漏：label/hint 不得包含完整事实正文。
    expect(prompt).toContain("不得出现完整的事实正文");
  });
});

describe("buildNarrationPrompt", () => {
  it("旁白明确单段单节拍、全量覆盖及局部事实归属", () => {
    const prompt = buildNarrationPrompt(contextFor(approvedPlan(), FIXTURE_NARRATION_UNIT), {
      attempt: 1, reason: "invalid_schema", rejectionCode: "unit_output_beat_ambiguous",
    });
    expect(prompt).toContain("每个 part 最多一个 beatId");
    expect(prompt).toContain("必须覆盖全部必选节拍");
    expect(prompt).toContain("按语义拆成不同 part");
    expect(prompt).toContain("不可复制同一段正文");
    expect(prompt).toContain("不扩大知识范围");
    expect(prompt).toContain("unit_output_beat_ambiguous");
  });

  it("旁白 prompt 是玩家视角：可见事实进入，无 NPC 台词输出字段", () => {
    const plan = approvedPlan();
    const prompt = buildNarrationPrompt(contextFor(plan, FIXTURE_NARRATION_UNIT));
    expect(prompt).toContain("渡口昨夜有灯火");
    expect(prompt).not.toContain("speakerId");
    expect(prompt).not.toContain("私密事实");
  });

  it("旁白 prompt 渲染内容修复反馈与风格", () => {
    const plan = approvedPlan();
    const prompt = buildNarrationPrompt(contextFor(plan, FIXTURE_NARRATION_UNIT), REPAIR);
    expect(prompt).toContain("修复序号=2");
    expect(prompt).toContain("wuxia");
  });

  it("旁白 prompt 给出 parts 元素精确契约：facts 是 FactUse 对象数组，不是裸键数组", () => {
    const plan = approvedPlan();
    const prompt = buildNarrationPrompt(contextFor(plan, FIXTURE_NARRATION_UNIT));
    // 每个 part 的键集合被显式声明，避免模型多加键被 hasOnlyKeys 整体拒绝。
    expect(prompt).toContain("每个 part 恰有 4 键");
    // facts 必须写成 {"factId":…,"certainty":…} 对象；裸键数组是真实失败码
    // unit_output_parts_invalid 的成因。
    expect(prompt).toContain("绝不可写成裸事实键数组");
    expect(prompt).toContain("certainty");
    expect(prompt).toContain("known");
    expect(prompt).toContain("suspected");
    // evidence 的两种合法形态。
    expect(prompt).toContain("committed");
    expect(prompt).toContain("conditional");
  });

  it("旁白 prompt 声明必须披露的观察，且只允许 certainty 降级", () => {
    // 真实缺陷 observation_not_disclosed：prompt 完全没说要披露哪条观察，
    // 模型写 facts=[] 即被 collectDisclosures 拒绝，任何输出都无法通过。
    const plan = approvedPlan();
    const base = contextFor(plan, FIXTURE_NARRATION_UNIT);
    const context = {
      ...base,
      requiredObservations: [{ key: "obs_seen", factId: "fact_0", certainty: "known" as const }],
    };
    const prompt = buildNarrationPrompt(context);
    expect(prompt).toContain("必须披露的观察");
    expect(prompt).toContain("obs_seen");
    expect(prompt).toContain("fact_0");
    // 必须写进 facts，而不是只写进 beatIds/evidence。
    expect(prompt).toContain("必须写进 facts");
    expect(prompt).toContain("不算披露");
    // certainty 不得升级（可降级）。
    expect(prompt).toContain("不得高于");
    expect(prompt).toContain("绝不可写成 known");
  });

  it("旁白 prompt 在没有披露要求时不渲染披露段", () => {
    const plan = approvedPlan();
    const prompt = buildNarrationPrompt(contextFor(plan, FIXTURE_NARRATION_UNIT));
    expect(prompt).not.toContain("# 本单元必须披露的观察");
  });

  // 回归（缺陷 14）：同一事实在 visibleFacts 标 known、在披露要求标 suspected 时，
  // prompt 必须明确「按更低 certainty 写」，否则两套标注并存会让模型写出被
  // approveUnit 拒绝的输出（真实 smoke char_liu_2 → unit_output_fact_unavailable）。
  it("旁白 prompt 在同一事实 certainty 冲突时给出按更低值写的规则", () => {
    const plan = approvedPlan();
    const base = contextFor(plan, FIXTURE_NARRATION_UNIT);
    const context = {
      ...base,
      visibleFacts: [{ id: "fact_0", text: "盐仓夜里有人影。", certainty: "known" as const, sources: [] }],
      requiredObservations: [{ key: "obs_x", factId: "fact_0", certainty: "suspected" as const }],
    };
    const prompt = buildNarrationPrompt(context);
    expect(prompt).toContain("fact_0 同时出现在");
    expect(prompt).toContain("按更低的 certainty 写");
    // 无冲突时不渲染该提示。
    const clean = buildNarrationPrompt({
      ...base,
      visibleFacts: [{ id: "fact_0", text: "盐仓夜里有人影。", certainty: "suspected" as const, sources: [] }],
      requiredObservations: [{ key: "obs_x", factId: "fact_0", certainty: "suspected" as const }],
    });
    expect(clean).not.toContain("同时出现在");
  });

  it("旁白 prompt 只暴露一套事实命名：必选节拍不得泄漏计划语义键", () => {
    const plan = approvedPlan();
    const base = contextFor(plan, FIXTURE_NARRATION_UNIT);
    // 共享 fixture 的 requiredBeats 为空，这里显式构造一个携带语义键 factIds 的节拍：
    // 真实缺陷是 beat.factIds 用计划语义键（如 north_route_cut），而可见事实用实体 id
    // （如 fact_0），同一 prompt 出现两套命名 → 模型照抄语义键 → unit_output_fact_unavailable。
    const context = {
      ...base,
      requiredBeats: [{
        beatId: "beat_leak",
        kind: "atmosphere" as const,
        factIds: ["north_route_cut"],
        evidence: [],
        instruction: "交代渡口景象。",
      }],
      visibleFacts: [{ id: "fact_0", text: "北岭断路三月。", certainty: "known" as const, sources: [] }],
    };
    const prompt = buildNarrationPrompt(context);
    // 节拍段绝不能渲染「可引用事实=north_route_cut」。
    expect(prompt).not.toContain("可引用事实");
    expect(prompt).not.toContain("north_route_cut");
    // 节拍本身仍必须渲染（否则模型无从承接）。
    expect(prompt).toContain("beat_leak");
    // facts 段的 id 才是唯一权威，且必须明确禁止自造键名。
    expect(prompt).toContain("fact_0");
    expect(prompt).toContain("不得使用任何其他名字");
    expect(prompt).toContain("不得自己发明");
  });
});

describe("buildCharacterPrompt", () => {
  it("角色 prompt 携带公开人格与受控行为，不携带秘密事实", () => {
    const plan = approvedPlan();
    const prompt = buildCharacterPrompt(contextFor(plan, FIXTURE_NPC_A_UNIT));
    expect(prompt).toContain("老陈");
    expect(prompt).toContain("知情者");
    expect(prompt).toContain("withhold_source");
    expect(prompt).not.toContain("fact_secret");
    expect(prompt).not.toContain("私密事实");
  });

  it("角色 prompt 同样给出 parts 元素精确契约与 answeredBeatIds 语义", () => {
    const plan = approvedPlan();
    const prompt = buildCharacterPrompt(contextFor(plan, FIXTURE_NPC_A_UNIT));
    expect(prompt).toContain("每个 part 恰有 4 键");
    expect(prompt).toContain("绝不可写成裸事实键数组");
    expect(prompt).toContain("suspected");
    // answeredBeatIds 只能填确实承接了的节拍，不得凭空回填。
    expect(prompt).toContain("answeredBeatIds");
    expect(prompt).toContain("确实承接");
    // 与旁白同一约束：不得泄漏计划语义键。
    expect(prompt).not.toContain("可引用事实");
  });

  it("角色 prompt 声明必须披露的观察，并提示 certainty 只能降级", () => {
    // 真实缺陷 observation_disclosure_unavailable：观察声明 suspected 而说话人
    // 知识是 known 时，prompt 教模型写 known、判定却要求 suspected，必败。
    // 修复后判定放宽为「不得升级」，prompt 同步声明。
    const plan = approvedPlan();
    const base = contextFor(plan, FIXTURE_NPC_A_UNIT);
    const context = {
      ...base,
      requiredObservations: [{ key: "obs_liuqi", factId: "fact_0", certainty: "suspected" as const }],
    };
    const prompt = buildCharacterPrompt(context);
    expect(prompt).toContain("必须披露的观察");
    expect(prompt).toContain("obs_liuqi");
    expect(prompt).toContain("fact_0");
    expect(prompt).toContain("必须写进 facts");
    expect(prompt).toContain("不算披露");
    expect(prompt).toContain("不得高于");
    expect(prompt).toContain("绝不可写成 known");
  });

  it("角色 prompt 在没有披露要求时不渲染披露段", () => {
    const plan = approvedPlan();
    const prompt = buildCharacterPrompt(contextFor(plan, FIXTURE_NPC_A_UNIT));
    expect(prompt).not.toContain("# 本单元必须披露的观察");
  });

  // 回归（缺陷 14）：真实 smoke char_liu_2 的失败：同一 fact 在「你可说的事实」
  // 标 known、在披露要求标 suspected，prompt 必须给出唯一的取舍规则。
  it("角色 prompt 在同一事实 certainty 冲突时给出按更低值写的规则", () => {
    const plan = approvedPlan();
    const base = contextFor(plan, FIXTURE_NPC_A_UNIT);
    const context = {
      ...base,
      visibleFacts: [{ id: "fact_0", text: "盐仓夜里有人影。", certainty: "known" as const, sources: [] }],
      requiredObservations: [{ key: "obs_x", factId: "fact_0", certainty: "suspected" as const }],
    };
    const prompt = buildCharacterPrompt(context);
    expect(prompt).toContain("fact_0 同时出现在");
    expect(prompt).toContain("按更低的 certainty 写");
    // 侧栏标题不再宣称「certainty 不得改写」（那只在无冲突时成立）。
    expect(prompt).not.toContain("certainty 不得改写");
  });
});

describe("buildChoicePrompt", () => {
  it("choice prompt 只返回两条玩家直接说出的对白，携带候选意图", () => {
    const plan = approvedPlan();
    const prompt = buildChoicePrompt(contextFor(plan, FIXTURE_CHOICE_UNIT));
    expect(prompt).toContain("只返回玩家直接说出的对白");
    expect(prompt).toContain("cand_route");
    expect(prompt).toContain("cand_alt");
    expect(prompt).toContain("讨论目标：");
    expect(prompt).not.toContain("我想去loc_1看看。");
  });
  it("规划自由文本夹带未引用的秘密也不进入任何表达 prompt", () => {
    const base = approvedPlan();
    const secret = "UNREFERENCED_PRIVATE_PLOT";
    if (base.choiceExpression?.kind !== "ordinary") throw new Error("ordinary fixture required");
    const [left, right] = base.choiceExpression.options;
    const plan: ApprovedPlan = { ...base,
      units: base.units.map(unit => ({ ...unit, requiredBeats: [{
        beatId: "atmosphere", kind: "atmosphere", factIds: [], evidence: [], instruction: secret,
      }] })),
      choiceExpression: { ...base.choiceExpression, options: [
        { ...left, publicIntent: { text: secret, facts: [], evidence: [], beatIds: [] } },
        { ...right, publicIntent: { text: secret, facts: [], evidence: [], beatIds: [] } },
      ] },
    };
    for (const unit of plan.units) {
      const context = contextFor(plan, unit.key);
      const prompt = unit.stage === "choices" ? buildChoicePrompt(context)
        : unit.stage === "character" ? buildCharacterPrompt(context) : buildNarrationPrompt(context);
      expect(prompt).not.toContain(secret);
    }
  });
});
