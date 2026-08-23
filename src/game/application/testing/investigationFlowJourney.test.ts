import { describe, it, expect } from "vitest";
import { createDeterministicEvolutionSource } from "@/game/application/deterministicEvolutionSource";
import {
  buildSelectableSceneCandidates,
  createDeterministicSceneSource,
  formatSceneChoiceLabel,
} from "@/game/application/deterministicSceneSource";
import { generatePendingScene } from "@/game/application/generatePendingScene";
import type { SceneGenerationContext } from "@/game/application/sceneGenerationContext";
import type { LinearActionNarrative, ScenePerformanceProposal, SceneSource } from "@/game/application/sceneSource";
import type { WorldEvolutionSource } from "@/game/application/worldEvolutionSource";
import type { GameLogger } from "@/game/logging/logTypes";
import type { GameRecord } from "@/game/application/server/persistence/gameRepository";
import {
  createJourneyGame,
  playIssuedChoice,
  advanceScene,
  loadGameView,
  journeyNow,
  type InMemoryRepo,
} from "./foundationJourney.testutil";

// ---------------------------------------------------------------------------
// Task 1 单线调查流程的端到端旅程回归（Chain A / Chain B）：
// 开局切片 → 首次对话触发第 2 幕具象化（deterministic evolution source，
// 真实武侠 beats：顾砚/北巷旧道/车轮印）→ 手渡场景由 fake live source 预生成
// investigate/move 叙事并随审批持久化 → 调查消费队列；抵达目标 NPC 时若队列
// 不完整则补做一次 live 生成完整场景 → 抵达新地点与顾砚展开对话。Chain B 复跑同一旅程，验证 AI 未提供
// 叙事时调查/移动仍即时完成，source=fallback 且记录 linear_narrative_fallback。
// ---------------------------------------------------------------------------

const SEED = "q20";
const INVESTIGATE_LABEL = "调查酒楼后巷的车轮印";
const MOVE_LABEL = "前往北巷旧道";
const GUYAN_TALK_LABEL = "与顾砚交谈";
const GUYAN_NAME = "顾砚";
const NORTH_LANE_NAME = "北巷旧道";
const WHEEL_TRACK_FACT_TEXT = "车轮印在后巷泥水中断续向北延伸";

type FakeLiveSource = {
  readonly source: SceneSource;
  readonly callCount: () => number;
};

/** fake live source：AI 应答（source=generated）；withLinearNarratives=false 时模拟 AI 未预生成叙事。 */
function createFakeLiveSceneSource(withLinearNarratives: boolean): FakeLiveSource {
  let calls = 0;
  const base = createDeterministicSceneSource();
  const source: SceneSource = {
    async generateScene(context: SceneGenerationContext) {
      calls += 1;
      const baseResult = await base.generateScene(context);
      if (!baseResult.ok) throw new Error(JSON.stringify({
        job: context.job.actionSummary,
        eventKind: context.job.resolvedEvent.eventKind,
        objective: context.objectiveTarget,
        focus: context.focusNpcContext?.id,
        present: context.presentNpcs.map((npc) => String(npc.id)),
        candidates: buildSelectableSceneCandidates(context),
      }));
      if (!withLinearNarratives) {
        return { ...baseResult, proposal: { ...baseResult.proposal, source: "generated" } };
      }
      const proposal = baseResult.proposal;
      const npcDialogues = context.focusNpcContext !== undefined && context.presentNpcs.length > 1
        ? context.presentNpcs
          .filter((npc) => String(npc.id) !== String(proposal.npcLine?.npcId))
          .map((npc) => ({
            npcId: String(npc.id),
            text: `我在${context.currentLocation.name}忙着自己的事。你若有正事，先去找眼前正在交谈的人。`,
          }))
        : undefined;
      const narratives: LinearActionNarrative[] = (context.upcomingLinearObjectives ?? []).flatMap(
        (ref): readonly LinearActionNarrative[] => {
          if (ref.kind === "discover_fact") {
            const entry: LinearActionNarrative = {
              actionKind: "investigate",
              factId: String(ref.factId),
              narration: `你循着${ref.investigationLabel}留下的痕迹仔细查看：${ref.factText}`,
            };
            return [entry];
          }
          if (ref.kind === "visit_location") {
            const entry: LinearActionNarrative = {
              actionKind: "move",
              locationId: String(ref.locationId),
              narration: `你决定动身前往${ref.locationName}，把车轮印的来路查个清楚。`,
              ...(ref.arrivalNpc === undefined ? {} : {
                arrivalNpcLine: {
                  npcId: String(ref.arrivalNpc.id),
                  text: `我就是你要找的${ref.arrivalNpc.name}。镖局出事那晚，我亲眼见过一件关键的事。`,
                  emotion: "neutral" as const,
                  usedFactIds: [],
                },
              }),
            };
            return [entry];
          }
          return [];
        },
      );
      // 真实 live 源会在同一份剧情上下文上润色对白选项；直接复用确定性
      // 模板 label 的 generated 提案会被审批器以 stale_choice_template 拒绝。
      const selectable = buildSelectableSceneCandidates(context);
      const relabel = (choice: ScenePerformanceProposal["choices"][number]): ScenePerformanceProposal["choices"][number] => {
        const candidate = selectable.find((entry) => entry.candidateId === choice.candidateId);
        if (candidate === undefined || candidate.action.type !== "talk") return choice;
        const action = candidate.action;
        const npc = context.presentNpcs.find((entry) => String(entry.id) === String(action.npcId));
        const npcName = npc?.name ?? "对方";
        return {
          candidateId: choice.candidateId,
          label: formatSceneChoiceLabel(
            action,
            action.dialogueAct === "support"
              ? `想请${npcName}把这条线索的来龙去脉再说细一些`
              : `向${npcName}提出质疑，请她把话说明白`,
          ),
        };
      };
      const relabeledChoices = proposal.choices.map(relabel);
      return {
        ok: true,
        proposal: {
          ...proposal,
          ...(npcDialogues === undefined ? {} : { npcDialogues }),
          choices: relabeledChoices,
          ...(narratives.length > 0 ? { linearActionNarratives: narratives } : {}),
          source: "generated",
        },
      };
    },
  };
  return { source, callCount: () => calls };
}

type CapturedLog = { readonly level: "info" | "warn" | "error"; readonly event: string; readonly details?: Record<string, unknown> };

function createCapturingLogger(): { readonly logger: GameLogger; readonly events: readonly CapturedLog[] } {
  const events: CapturedLog[] = [];
  const logger: GameLogger = {
    info: (event, details) => events.push({ level: "info", event, details }),
    warn: (event, details) => events.push({ level: "warn", event, details }),
    error: (event, details) => events.push({ level: "error", event, details }),
  };
  return { logger, events };
}

type JourneyHandles = {
  readonly store: InMemoryRepo;
  readonly fake: FakeLiveSource;
  readonly logger: ReturnType<typeof createCapturingLogger>;
  readonly evolution: WorldEvolutionSource;
  readonly openingNpcName: string;
  readonly fixed: (label: string) => Promise<void>;
  readonly scene: () => Promise<void>;
  readonly liveScene: () => Promise<void>;
  readonly record: () => GameRecord;
  readonly sceneOf: () => NonNullable<GameRecord["storyState"]["narrative"]["currentScene"]>;
};

/** 共享旅程步骤：序幕 → 交谈（第 1 幕完成）→ 第 2 幕具象化手渡 → 沈掌柜二次对话。 */
async function runJourney(withLinearNarratives: boolean): Promise<JourneyHandles> {
  const created = await createJourneyGame(undefined, undefined, SEED, "short");
  const store = created.repo;
  const evolution = createDeterministicEvolutionSource();
  const fake = createFakeLiveSceneSource(withLinearNarratives);
  const logger = createCapturingLogger();

  const fixed = async (label: string) => {
    const result = await playIssuedChoice(store.repo, label, evolution);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  };
  const scene = async () => {
    const ok = await advanceScene(store.repo, evolution);
    expect(ok, "场景生成应保存").toBe(true);
  };
  const liveScene = async () => {
    const result = await generatePendingScene({
      repository: store.repo,
      sceneSource: fake.source,
      worldEvolutionSource: evolution,
      logger: logger.logger,
      now: journeyNow,
    });
    expect(result, JSON.stringify({ result, events: logger.events })).toBe("saved");
  };
  const record = (): GameRecord => {
    const current = store.record();
    if (current === null) throw new Error("游戏记录不可用");
    return current;
  };
  const sceneOf = () => {
    const current = record().storyState.narrative.currentScene;
    if (current === null) throw new Error("当前场景不可用");
    return current;
  };

  await scene(); // 序幕
  const openingNpcName = record().worldState.npcs[0]?.name ?? "";
  expect(openingNpcName).not.toBe("");

  await fixed("回应"); // 正式对白第 1 轮
  if (!withLinearNarratives) {
    const result = await generatePendingScene({
      repository: store.repo,
      sceneSource: fake.source,
      worldEvolutionSource: evolution,
      logger: logger.logger,
      now: journeyNow,
    });
    expect(result).toBe("failed");
    return { store, fake, logger, evolution, openingNpcName, fixed, scene, liveScene, record, sceneOf };
  }
  await liveScene(); // 第 2 幕具象化 + 手渡场景

  // 手渡场景的第二个正式对白选择完成会话，收尾场景只返回一个 handoff。
  await fixed("质疑");
  await liveScene();

  return { store, fake, logger, evolution, openingNpcName, fixed, scene, liveScene, record, sceneOf };
}

describe("AI 预生成单线调查流程旅程（Task 1 端到端回归）", () => {
  it("Chain A：手渡场景预生成两段叙事；调查消费队列，抵达目标 NPC 时生成完整场景", async () => {
    const journey = await runJourney(true);

    // 第 2 幕手渡后：当前权威目标进入 discover_fact，队列持两段 AI 叙事。
    let view = await loadGameView(journey.store.repo);
    expect(view.story.currentObjectiveLabel).toBe(INVESTIGATE_LABEL);
    const queueAfterHandoff = journey.record().storyState.narrative.linearNarrativeQueue ?? [];
    expect(queueAfterHandoff).toHaveLength(2);
    expect(queueAfterHandoff.map((entry) => entry.actionKind)).toEqual(["investigate", "move"]);
    expect(queueAfterHandoff.every((entry) => entry.source === "generated")).toBe(true);
    expect(journey.fake.callCount()).toBe(2);

    // 调查：即时行动，零 live 调用；叙事来自队列并含权威 factText 语义。
    const callsBeforeInvestigate = journey.fake.callCount();
    const approachLabel = journey.record().worldState.worldFacts
      .find((fact) => fact.investigationLabel === "酒楼后巷的车轮印")
      ?.investigationApproaches?.[0]?.label ?? "";
    expect(approachLabel).not.toBe("");
    await journey.fixed(approachLabel);
    await journey.liveScene();
    expect(journey.fake.callCount()).toBe(callsBeforeInvestigate);
    const investigateScene = journey.sceneOf();
    expect(investigateScene.source).toBe("generated");
    expect(investigateScene.narration).toContain(WHEEL_TRACK_FACT_TEXT);
    expect(investigateScene.narration).toContain(NORTH_LANE_NAME);
    // Task 5：即时叙事点名所选方式与已结算的证据质量（clean 无动静代价）。
    expect(investigateScene.narration).toContain(approachLabel);
    expect(investigateScene.narration).toContain("没有惊动任何人");
    // 消费 investigate 叙事，move 叙事保留；目标自动流转。
    const queueAfterInvestigate = journey.record().storyState.narrative.linearNarrativeQueue ?? [];
    expect(queueAfterInvestigate).toHaveLength(1);
    expect(queueAfterInvestigate[0]).toMatchObject({ actionKind: "move" });
    view = await loadGameView(journey.store.repo);
    expect(view.story.currentObjectiveLabel).toBe(MOVE_LABEL);

    // 移动：同样即时完成，消费 move 叙事；抵达北巷旧道后顾砚在场可交谈。
    const northLaneId = journey.record().worldState.locations
      .find((location) => location.name === NORTH_LANE_NAME)?.id ?? "";
    expect(northLaneId).not.toBe("");
    const callsBeforeMove = journey.fake.callCount();
    await journey.fixed(MOVE_LABEL);
    await journey.liveScene();
    // 目标 NPC 在抵达后必须拿到完整对白场景；若队列只有不完整的 arrival
    // 叙事，边界守卫会跳过它并补做一次 live 生成。
    expect(journey.fake.callCount()).toBe(callsBeforeMove + 1);
    expect(journey.record().worldState.currentLocationId).toBe(northLaneId);
    const moveScene = journey.sceneOf();
    expect(moveScene.source).toBe("generated");
    expect(moveScene.narration).toContain(MOVE_LABEL);
    expect(journey.record().storyState.narrative.linearNarrativeQueue ?? []).toHaveLength(0);
    view = await loadGameView(journey.store.repo);
    expect(view.story.currentObjectiveLabel).toBe(GUYAN_TALK_LABEL);
    expect(view.currentLocation.npcs.map((npc) => npc.name)).toContain(GUYAN_NAME);

    // 与顾砚对话：对话场景仍由 live source 正常生成。
    const guyanId = journey.record().worldState.npcs
      .find((npc) => npc.name === GUYAN_NAME)?.id ?? "";
    expect(guyanId).not.toBe("");
    const callsBeforeTalk = journey.fake.callCount();
    await journey.fixed(GUYAN_TALK_LABEL);
    await journey.liveScene();
    expect(journey.fake.callCount()).toBe(callsBeforeTalk + 1);
    const talkScene = journey.sceneOf();
    expect(talkScene.npcLine?.npcId).toBe(guyanId);
    expect(talkScene.source).toBe("generated");
  });

  it("Chain B：缺少抵达目标 NPC 预生成对白时失败并等待手动重试，不写入 fallback", async () => {
    const journey = await runJourney(false);

    // 缺少 arrivalNpcLine 的内容契约在自动内容重试后仍失败；不能生成
    // fallback 场景，更不能让玩家抵达后看到通用 NPC 台词。
    expect(journey.record().storyState.narrative.linearNarrativeQueue ?? []).toHaveLength(0);
    expect(journey.record().storyState.narrative.generation.status).toBe("failed");
    expect(journey.fake.callCount()).toBe(2);
  });
});
