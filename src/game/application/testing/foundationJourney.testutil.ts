import type { GameRepository, GameRecord, ApplyStateInput } from "@/game/application/server/persistence/gameRepository";
import type { GameId } from "@/game/application/server/persistence/gameRepository";
import type { StoryState } from "@/game/domain/storyState";
import type { WorldState } from "@/game/domain/worldState";
import type { Interaction } from "@/game/domain/action";
import type { ActionChoiceMap } from "@/game/application/actionConverter";
import { performTurn } from "@/game/application/performTurn";
import { createGame, createFixtureOpeningSource } from "@/game/application/createGame";
import { generatePendingScene } from "@/game/application/generatePendingScene";
import { createDeterministicSceneSource } from "@/game/application/deterministicSceneSource";
import { buildSceneGenerationContext, type SceneGenerationContext } from "@/game/application/sceneGenerationContext";
import type { SceneSource, ScenePerformanceProposal } from "@/game/application/sceneSource";
import { createDeterministicEvolutionSource } from "@/game/application/deterministicEvolutionSource";
import type { WorldEvolutionSource } from "@/game/application/worldEvolutionSource";
import type { WorldDeltaProposal } from "@/game/domain/worldDelta";
import { createRuleIntentParser } from "@/game/application/server/ai/liveIntentParserSource";
import type { IntentParserSource } from "@/game/gameplay/rpg/intentParser";
import { asGameId } from "@/game/application/server/persistence/gameRepository";
import { buildChoiceMap } from "@/game/application/buildChoiceMap";
import { projectGameSessionView, type GameSessionView, type PlayerChoiceView } from "@/game/application/gameSessionView";
import type { GameLength, GameTypeId } from "@/game/domain/newGame";

// ---------------------------------------------------------------------------
// Foundation 完整离线旅程 harness。
//
// - 内存 GameRepository（CAS 语义与 SQLite 一致）。
// - 经 createGame + fixture world source 创建经验证世界。
// - playTurn 包一层 performTurn；advanceScene 用确定性 SceneSource 清空 pending。
// - 记录每次规则提交，供"单次 CAS / reload / 确定性 replay"断言。
// ---------------------------------------------------------------------------

const FIXED_NOW = "2026-08-09T00:00:00.000Z";
let _now = FIXED_NOW;
export const setJourneyNow = (v: string) => { _now = v; };
export const journeyNow = () => _now;

export type InMemoryRepo = {
  readonly repo: GameRepository;
  readonly record: () => GameRecord | null;
  readonly applyCalls: () => readonly ApplyStateInput[];
  /** 用传入的双状态覆盖当前记录（模拟一次进程重启后从持久化恢复）。 */
  readonly restore: (record: GameRecord) => void;
};

export function createInMemoryRepo(_gameId: GameId): InMemoryRepo {
  let record: GameRecord | null = null;
  const applyCallsHistory: ApplyStateInput[] = [];
  const repo: GameRepository = {
    async createInitialGame(input) {
      if (record !== null) return { ok: false as const, code: "ACTIVE_GAME_EXISTS" as const };
      record = { gameId: input.gameId, worldState: input.worldState, storyState: input.storyState, revision: 0, createdAt: input.createdAt };
      return { ok: true as const };
    },
    async replaceCurrentGame() { return { ok: false as const, code: "NO_ACTIVE_GAME" as const }; },
    async getCurrentGame() {
      if (record === null) return { ok: true, status: "none" };
      return { ok: true, status: "active", record };
    },
    async applyState(input) {
      if (record === null) return { ok: false as const, code: "NO_ACTIVE_GAME" as const };
      applyCallsHistory.push(input);
      if (input.expectedRevision !== record.revision) return { ok: false as const, code: "STALE_GAME_REVISION" as const };
      const incrementRevision = input.incrementRevision ?? true;
      record = {
        ...record,
        worldState: input.nextWorldState,
        storyState: input.nextStoryState,
        revision: incrementRevision ? record.revision + 1 : record.revision,
      };
      return { ok: true, record };
    },
    async applySceneWriteBack(input) {
      if (record === null) return { ok: false as const, code: "NO_ACTIVE_GAME" as const };
      if (input.expectedRevision !== record.revision) return { ok: false as const, code: "STALE_GAME_REVISION" as const };
      record = { ...record, worldState: input.nextWorldState, storyState: input.nextStoryState, revision: record.revision + 1 };
      return { ok: true, record };
    },
    async clearCurrentGame() { record = null; return { ok: true as const }; },
  };
  return {
    repo,
    record: () => record,
    applyCalls: () => applyCallsHistory,
    restore: (next) => { record = next; },
  };
}

export type JourneyTurnResult = {
  readonly ok: boolean;
  readonly code: string;
  readonly revisionAfter: number;
  readonly turnNumberAfter: number;
};

/** 规则意图源（离线确定性）：让自由文本可靠分类 support/challenge 等。 */
const RULE_INTENT_SOURCE: IntentParserSource = createRuleIntentParser();

/**
 * 旅程用确定性世界演化源。`createDeterministicEvolutionSource`（Task 3）只在
 * next_act 时提议单一固定名称（传讯人/循迹而行）且不产新地点/物品——第二次
 * next_act 会被 duplicate_name 审批拒绝，且无法满足"新 NPC + 新地点/物品"的
 * 具象化断言。本源逐幕铸造唯一名称，并在每幕附上信物（物品）、守径人（敌人）
 * 与延伸之地（地点），让旅程能覆盖 拾取物品 / 战斗 / 地图移动 / 多幕推进；
 * ending_pair 与 pacing 委托 Task 3 确定性源（零 AI）。
 */
function journeyNextActProposal(act: number, currentLocationId: string): WorldDeltaProposal {
  return {
    beatSummary: `第${act}幕的传讯人带来新的线索`,
    newLocation: {
      name: `延伸之地·${act}`,
      description: `第${act}幕线索延伸出的一处新地界。`,
      scale: "scene",
      connectFromLocationId: currentLocationId,
    },
    newNpc: {
      name: `传讯人·${act}`,
      role: "信使",
      description: `风尘仆仆赶来的第${act}幕传讯人。`,
      locationRef: { kind: "new_location" },
      goals: [`传递第${act}幕的线索`],
    },
    newItem: {
      name: `信物·${act}`,
      description: `第${act}幕途中拾得的信物。`,
      locationRef: "new_location",
    },
    newEnemy: {
      name: `守径人·${act}`,
      tier: "normal",
      locationRef: "new_location",
    },
    newFact: null,
    nextMainQuest: {
      name: `循迹第${act}幕`,
      description: `与第${act}幕的传讯人交谈，继续追索。`,
      objectiveText: `与传讯人·${act}交谈`,
    },
    endingPair: null,
  };
}

export function createJourneyEvolutionSource(): WorldEvolutionSource {
  const deterministic = createDeterministicEvolutionSource();
  return {
    async propose(ctx) {
      switch (ctx.need.kind) {
        case "none":
          return { ok: true, proposal: null };
        case "next_act":
          return { ok: true, proposal: journeyNextActProposal(ctx.need.act, String(ctx.worldState.currentLocationId)) };
        case "ending_pair":
          // 结局对走 Task 3 确定性源的规则化要求（关键 NPC 亲和度分歧）。
          return deterministic.propose(ctx);
        case "pacing":
          return deterministic.propose(ctx);
      }
    },
  };
}

/** 旅程默认的世界演化源：让幕边界具象化真实触发（旧 harness 以 undefined 运行）。 */
const JOURNEY_EVOLUTION_SOURCE: WorldEvolutionSource = createJourneyEvolutionSource();

/** 执行一个回合：先清空 pending（如无 pending 则跳过），再走 performTurn。 */
export async function playTurn(
  repo: GameRepository,
  interaction: Interaction,
  choiceMap: ActionChoiceMap = new Map(),
  now: () => string = journeyNow,
  worldEvolutionSource: WorldEvolutionSource | undefined = JOURNEY_EVOLUTION_SOURCE,
): Promise<JourneyTurnResult> {
  const current = await repo.getCurrentGame();
  if (!current.ok || current.status !== "active") return { ok: false, code: "NO_ACTIVE_GAME", revisionAfter: -1, turnNumberAfter: -1 };
  const revision = current.record.revision;
  const turnNumber = current.record.storyState.turnNumber;
  const result = await performTurn(
    { gameId: current.record.gameId, actionId: `act_j_${turnNumber}`, interaction, expectedRevision: revision, choiceMap },
    { repository: repo, now, worldEvolutionSource, intentParserSource: RULE_INTENT_SOURCE },
  );
  if (result.ok) {
    const after = await repo.getCurrentGame();
    const turnNumberAfter = after.ok && after.status === "active" ? after.record.storyState.turnNumber : turnNumber;
    return { ok: true, code: "ok", revisionAfter: result.revision, turnNumberAfter };
  }
  return { ok: false, code: result.code, revisionAfter: revision, turnNumberAfter: turnNumber };
}

/** 用确定性 SceneSource 清空当前 pending job（无 pending 返回 true）。 */
export async function advanceScene(
  repo: GameRepository,
  worldEvolutionSource: WorldEvolutionSource | undefined = JOURNEY_EVOLUTION_SOURCE,
): Promise<boolean> {
  const sceneSource: SceneSource = createDeterministicSceneSource();
  const result = await generatePendingScene({
    repository: repo,
    sceneSource,
    worldEvolutionSource,
    now: journeyNow,
  });
  return result === "saved" || result === "not_pending";
}

/** 创建经验证世界（fixture source 经 schema parse → validate → compile）。 */
export async function createJourneyGame(
  gameId: GameId = asGameId("journey_g1"),
  repo?: InMemoryRepo,
  seed = "journey_seed",
  gameLength: GameLength = "short",
  gameType: GameTypeId = "wuxia",
): Promise<{ repo: InMemoryRepo; gameId: GameId }> {
  const store = repo ?? createInMemoryRepo(gameId);
  const created = await createGame(
    { gameId, gameType, gameLength, seed },
    { repository: store.repo, source: createFixtureOpeningSource(), now: journeyNow, aiEnabled: false },
  );
  if (!created.ok) throw new Error(`创建世界失败：${created.code}`);
  return { repo: store, gameId };
}

export async function loadGameView(repo: GameRepository): Promise<GameSessionView> {
  const loaded = await repo.getCurrentGame();
  if (!loaded.ok || loaded.status !== "active") throw new Error("游戏视图不可用");
  return projectGameSessionView(loaded.record.worldState, loaded.record.storyState, loaded.record.revision, "journey-session");
}

function allIssuedChoices(view: GameSessionView): readonly PlayerChoiceView[] {
  return [
    ...view.currentLocation.actions,
    ...view.worldMap.locations.flatMap((location) => location.travelChoice === null ? [] : [location.travelChoice]),
    ...view.obtainableItems.map((item) => item.choice),
    ...view.narrative.choices,
    ...view.narrative.npcDialogues.flatMap((dialogue) => dialogue.choices),
    ...(view.battle?.controls ?? []),
  ];
}

/** 像生产 composition root 一样，只消费 projector 下发的 opaque token。 */
export async function playIssuedChoice(
  repo: GameRepository,
  labelIncludes: string,
  worldEvolutionSource: WorldEvolutionSource | undefined = JOURNEY_EVOLUTION_SOURCE,
): Promise<JourneyTurnResult & { readonly choiceToken: string }> {
  const loaded = await repo.getCurrentGame();
  if (!loaded.ok || loaded.status !== "active") throw new Error("游戏记录不可用");
  const view = projectGameSessionView(loaded.record.worldState, loaded.record.storyState, loaded.record.revision, "journey-session");
  const dialogueChoices = view.narrative.npcDialogues.flatMap((dialogue) => dialogue.choices);
  // 旅程测试只消费 opaque token；“回应/质疑”是旧版展示前缀，不再依赖
  // 它们出现在玩家可见文案中，按对白位次选择对应的服务器选项即可。
  const legacyDialogueChoice = labelIncludes === "回应"
    ? dialogueChoices[0]
    : labelIncludes === "追问" || labelIncludes === "质疑"
      ? dialogueChoices[1]
      : undefined;
  const choice = legacyDialogueChoice ?? allIssuedChoices(view).find((entry) => entry.label.includes(labelIncludes));
  if (choice === undefined) throw new Error(`找不到服务器选项：${labelIncludes}`);
  // Task 4：buildChoiceMap 为每个已审批调查方式分别铸造 opaque token 并携带
  // approachId；选择驱动调查旅程必须挑选一个具体方式（如 approaches[0].label），
  // 不再依赖此处的任何注入桥接。
  const result = await playTurn(
    repo,
    { kind: "fixed_choice", choiceToken: choice.choiceToken },
    buildChoiceMap(loaded.record.worldState, loaded.record.storyState, loaded.record.revision),
    journeyNow,
    worldEvolutionSource,
  );
  return { ...result, choiceToken: choice.choiceToken };
}

export async function playIssuedTravelToUnvisited(
  repo: GameRepository,
  worldEvolutionSource: WorldEvolutionSource | undefined = JOURNEY_EVOLUTION_SOURCE,
): Promise<JourneyTurnResult & { readonly choiceToken: string }> {
  const loaded = await repo.getCurrentGame();
  if (!loaded.ok || loaded.status !== "active") throw new Error("游戏记录不可用");
  const view = projectGameSessionView(loaded.record.worldState, loaded.record.storyState, loaded.record.revision, "journey-session");
  const choice = view.worldMap.locations.find(
    (location) => !location.current && !location.visited && location.travelChoice !== null,
  )?.travelChoice;
  if (choice === null || choice === undefined) throw new Error("找不到服务器下发的未到访地点选项");
  const result = await playTurn(
    repo,
    { kind: "fixed_choice", choiceToken: choice.choiceToken },
    buildChoiceMap(loaded.record.worldState, loaded.record.storyState, loaded.record.revision),
    journeyNow,
    worldEvolutionSource,
  );
  return { ...result, choiceToken: choice.choiceToken };
}

/** 从当前记录返回故事状态（reload 断言用）。 */
export async function loadStoryState(repo: GameRepository): Promise<StoryState | null> {
  const current = await repo.getCurrentGame();
  if (!current.ok || current.status !== "active") return null;
  return current.record.storyState;
}

export async function loadWorldState(repo: GameRepository): Promise<WorldState | null> {
  const current = await repo.getCurrentGame();
  if (!current.ok || current.status !== "active") return null;
  return current.record.worldState;
}

/** 从当前记录返回完整 GameRecord（场景断言/回读用）。 */
export async function loadGameRecord(repo: GameRepository): Promise<GameRecord | null> {
  const current = await repo.getCurrentGame();
  if (!current.ok || current.status !== "active") return null;
  return current.record;
}

/**
 * 对当前 pending 记录构造场景上下文 + 确定性场景提案（不写库）。
 * 供"场景覆盖全部强制节拍 / objectiveLink == HUD 当前目标"断言使用：
 * proposal 与 generatePendingScene 实际采用的确定性提案逐字节一致。
 */
export async function pendingSceneProposal(
  repo: GameRepository,
): Promise<{ context: SceneGenerationContext; proposal: ScenePerformanceProposal } | null> {
  const record = await loadGameRecord(repo);
  if (record === null) return null;
  if (record.storyState.narrative.generation.status !== "pending") return null;
  const context = buildSceneGenerationContext(record);
  const proposal = await createDeterministicSceneSource().generateScene(context);
  if (!proposal.ok) throw new Error("expected success");
  return { context, proposal: proposal.proposal };
}
