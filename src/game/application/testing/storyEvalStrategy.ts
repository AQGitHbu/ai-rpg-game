// ---------------------------------------------------------------------------
// storyEvalStrategy：评估旅程的确定性选择策略（spec §7 + Task 13 Step 4）。
// 只依赖评估专用 repository 读取结果的结构化子集（本地 StoryEvalGameRecord，
// 与真实 GameRecord/GameState 结构兼容），不经过客户端投影，
// 不触碰 entry points 安全红线。PRNG 为 mulberry32 级别，种子稳定可复现。
// explore：探索优先语义；objective：优先推进主线阶段/任务物品/战斗/
// 与任务目标 NPC 交谈的合法动作，同类才使用同一 PRNG。两个策略都产出
// 选择理由（记入 story.jsonl 的 playerChoice.reason）。
// ---------------------------------------------------------------------------

import { toDirectorContext } from "../runtimeNarrativeContexts";
import type { GameState, ScenarioBlueprint } from "@/game/domain";

/** GameRecord 的本地结构化子集：仅含策略实际读取的字段（边界守卫要求
 *  application 层不 import server 端口实现；真实 GameRecord/GameState 可赋值给本类型）。
 *  id 字段为 unknown：策略只做 String() 归一比较，不依赖 id 的具体品牌类型。 */
type StoryEvalGameRecord = Readonly<{
  blueprint: Readonly<{
    readonly quests: readonly Readonly<{
      readonly id: unknown;
      readonly kind: string;
      readonly objectives: readonly Readonly<{
        readonly kind: string;
        readonly locationId?: unknown;
        readonly npcId?: unknown;
        readonly itemId?: unknown;
        readonly factId?: unknown;
        readonly enemyId?: unknown;
      }>[];
    }>[];
  }>;
  state: Readonly<{
    readonly quests: readonly Readonly<{ readonly questId: unknown; readonly status: string }>[];
    readonly inventory: readonly unknown[];
    readonly currentLocationId: unknown;
    readonly visitedLocationIds: readonly unknown[];
    readonly defeatedEnemyIds?: readonly unknown[];
    readonly npcs: readonly Readonly<{ readonly npcId: unknown; readonly met: boolean }>[];
    readonly worldFacts: readonly Readonly<{ readonly factId: unknown; readonly discovered: boolean }>[];
    readonly narrative: Readonly<{
      readonly currentScene: Readonly<{
        readonly choices: readonly { readonly actionKey: string }[];
      }> | null;
    }>;
  }>;
}>;

/** mulberry32：32 位种子 PRNG，返回 [0,1) 均匀序列。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 把任意字符串稳定散列为 32 位种子（FNV-1a 变体）。 */
export function hashStringToSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function splitAction(actionKey: string): { kind: string; target: string } {
  const separator = actionKey.indexOf(":");
  if (separator < 0) return { kind: actionKey, target: "" };
  return { kind: actionKey.slice(0, separator), target: actionKey.slice(separator + 1) };
}

function actionKeyForObjective(objective: Readonly<{
  readonly kind: string;
  readonly locationId?: unknown;
  readonly npcId?: unknown;
  readonly itemId?: unknown;
  readonly factId?: unknown;
  readonly enemyId?: unknown;
}>): string {
  const target = objective.locationId ?? objective.npcId ?? objective.itemId ?? objective.factId ?? objective.enemyId;
  const prefix = objective.kind === "obtain_item"
    ? "take_item"
    : objective.kind === "talk_to_npc"
      ? "talk"
      : objective.kind === "visit_location"
        ? "move"
        : objective.kind === "discover_fact"
          ? "investigate"
          : "start_battle";
  return `${prefix}:${String(target)}`;
}

/** 探索不应提前完成尚未解锁的主线幕，否则 fixed-point reconciliation 会在
 * 解锁时瞬间级联完成多幕，玩家看不到中间的导演/分支流程。 */
function lockedMainObjectiveActionKeys(record: StoryEvalGameRecord): ReadonlySet<string> {
  const statusById = new Map(record.state.quests.map((quest) => [String(quest.questId), quest.status]));
  return new Set(record.blueprint.quests
    .filter((quest) => quest.kind === "main" && statusById.get(String(quest.id)) === "locked")
    .flatMap((quest) => quest.objectives.map(actionKeyForObjective)));
}

/**
 * 行动是否为探索性：前往未访问地点 / 与未见 NPC 交谈 / 调查未发现事实 /
 * 拾取物品（功能推进）。move/talk/investigate 是否探索取决于 GameRecord 状态。
 */
export function isExploratory(
  actionKey: string,
  record: StoryEvalGameRecord,
  allowedMainlineActionKeys: ReadonlySet<string> = new Set(),
): boolean {
  if (lockedMainObjectiveActionKeys(record).has(actionKey) && !allowedMainlineActionKeys.has(actionKey)) return false;
  const { kind, target } = splitAction(actionKey);
  if (kind === "take_item") return true;
  if (kind === "investigate") {
    const fact = record.state.worldFacts.find((entry) => String(entry.factId) === target);
    return fact === undefined || !fact.discovered;
  }
  if (kind === "move") {
    return !record.state.visitedLocationIds.some((id) => String(id) === target);
  }
  if (kind === "talk") {
    const npc = record.state.npcs.find((entry) => String(entry.npcId) === target);
    return npc === undefined || !npc.met;
  }
  return false;
}

/** 探索优先选择：唯一探索选项必选；同类掷硬币；无探索时优先沿当前主线
 * 的合法目标/路由动作，避免已探索区域之间随机往返导致主线饥饿；没有
 * 可用主线动作才随机。返回下标与理由（记入 story.jsonl）。 */
export function pickNarrativeChoice(
  record: StoryEvalGameRecord,
  rand: () => number,
): { index: 0 | 1; reason: "explore" | "random" | "mainline:recovery" } {
  const choices = record.state.narrative.currentScene?.choices ?? [];
  if (choices.length !== 2) return { index: 0, reason: "random" };
  const activeMainObjective = activeMainObjectiveOf(record);
  const mainlineActionKeys = new Set(
    [activeMainObjective?.suggestedActionKey, activeMainObjective?.targetActionKey]
      .filter((key): key is string => typeof key === "string"),
  );
  const lockedObjectives = lockedMainObjectiveActionKeys(record);
  const safeIndexes = choices
    .map((choice, index) => (
      lockedObjectives.has(choice.actionKey) && !mainlineActionKeys.has(choice.actionKey) ? -1 : index
    ))
    .filter((index): index is 0 | 1 => index === 0 || index === 1);
  // 即使两个选项都不是“探索动作”，也不让随机选择提前完成尚未解锁
  // 的主线目标；否则后续 unlock 会 fixed-point 级联跳过中间幕。
  if (safeIndexes.length === 1) {
    const index = safeIndexes[0];
    return { index, reason: isExploratory(choices[index].actionKey, record) ? "explore" : "random" };
  }
  const exploreIndexes = choices
    .map((choice, index) => (isExploratory(choice.actionKey, record, mainlineActionKeys) ? index : -1))
    .filter((index): index is 0 | 1 => index === 0 || index === 1);
  if (exploreIndexes.length === 1) return { index: exploreIndexes[0], reason: "explore" };
  if (exploreIndexes.length === 2) return { index: rand() < 0.5 ? 0 : 1, reason: "explore" };
  const mainlineIndexes = choices
    .map((choice, index) => (mainlineActionKeys.has(choice.actionKey) ? index : -1))
    .filter((index): index is 0 | 1 => index === 0 || index === 1);
  if (mainlineIndexes.length > 0) {
    const suggestedIndex = mainlineIndexes.find((index) => choices[index].actionKey === activeMainObjective?.suggestedActionKey);
    return { index: suggestedIndex ?? mainlineIndexes[0], reason: "mainline:recovery" };
  }
  return { index: rand() < 0.5 ? 0 : 1, reason: "random" };
}

// ---------------------------------------------------------------------------
// objective 策略（Task 13 Step 4）：优先选择推进主线阶段、取得任务物品、
// 战斗或与任务目标 NPC 交谈的合法动作；同类（同 tier）才使用同一 PRNG。
// tier 越小优先级越高：1=当前 active 主线任务的目标动作；2=任意 active
// 任务的目标动作；3=功能性动作（拾取物品/开战）；4=探索性动作；5=其他。
// ---------------------------------------------------------------------------

type ObjectivePreference = Readonly<{ tier: number; reason: string }>;

type ActiveObjectiveProjection = Readonly<{
  kind: string;
  targetId: string;
  targetActionKey: string;
  suggestedActionKey: string | null;
}>;

function objectiveTargetOf(objective: Readonly<{ kind: string; locationId?: unknown; npcId?: unknown; itemId?: unknown; factId?: unknown; enemyId?: unknown }>): string {
  const target = objective.locationId ?? objective.npcId ?? objective.itemId ?? objective.factId ?? objective.enemyId;
  return String(target);
}

function objectiveActionOf(objective: Readonly<{ kind: string; locationId?: unknown; npcId?: unknown; itemId?: unknown; factId?: unknown; enemyId?: unknown }>): string {
  return `${objective.kind === "obtain_item" ? "take_item" : objective.kind === "talk_to_npc" ? "talk" : objective.kind === "visit_location" ? "move" : objective.kind === "discover_fact" ? "investigate" : "start_battle"}:${objectiveTargetOf(objective)}`;
}

function objectiveSatisfiedByState(
  objective: Readonly<{ kind: string; locationId?: unknown; npcId?: unknown; itemId?: unknown; factId?: unknown; enemyId?: unknown }>,
  record: StoryEvalGameRecord,
): boolean {
  const target = objectiveTargetOf(objective);
  switch (objective.kind) {
    case "visit_location": return record.state.visitedLocationIds.some((id) => String(id) === target);
    case "talk_to_npc": return record.state.npcs.some((npc) => String(npc.npcId) === target && npc.met);
    case "obtain_item": return record.state.inventory.some((id) => String(id) === target);
    case "discover_fact": return record.state.worldFacts.some((fact) => String(fact.factId) === target && fact.discovered);
    case "defeat_enemy": return (record.state.defeatedEnemyIds ?? []).some((id) => String(id) === target);
    default: return false;
  }
}

/**
 * 复用运行时导演上下文的路线投影，但由评估侧再次确认“当前未满足的
 * objective”，避免把同一主线中尚未轮到的未来 objective 当成当前目标。
 * 这里只影响评估旅程的选择器，不写入真实游戏状态。
 */
function activeMainObjectiveOf(record: StoryEvalGameRecord): ActiveObjectiveProjection | null {
  const activeQuestIds = new Set(
    record.state.quests.filter((quest) => quest.status === "active").map((quest) => String(quest.questId)),
  );
  const activeMainQuest = record.blueprint.quests.find(
    (quest) => quest.kind === "main" && activeQuestIds.has(String(quest.id)),
  );
  const objective = activeMainQuest?.objectives.find((entry) => !objectiveSatisfiedByState(entry, record));
  if (objective === undefined) return null;
  const targetActionKey = objectiveActionOf(objective);
  const projected = toDirectorContext({
    blueprint: record.blueprint as unknown as ScenarioBlueprint,
    state: record.state as unknown as GameState,
  }).activeMainObjective;
  return {
    kind: objective.kind,
    targetId: objectiveTargetOf(objective),
    targetActionKey,
    suggestedActionKey: projected?.kind === objective.kind && projected.targetId === objectiveTargetOf(objective)
      ? projected.suggestedActionKey
      : targetActionKey,
  };
}

/** 某任务的 objective 目标集合（按 kind 归一为字符串 ID 集合）。 */
function objectiveTargetsOf(
  objectives: readonly Readonly<{ readonly kind: string; readonly locationId?: unknown; readonly npcId?: unknown; readonly itemId?: unknown; readonly factId?: unknown; readonly enemyId?: unknown }>[],
  kind: string,
): readonly string[] {
  return objectives
    .filter((objective) => objective.kind === kind)
    .map((objective) => {
      const target =
        objective.locationId ?? objective.npcId ?? objective.itemId ?? objective.factId ?? objective.enemyId;
      return String(target);
    });
}

/** 行动相对 objective 策略的偏好分：无偏好返回 null。 */
function objectivePreferenceOf(actionKey: string, record: StoryEvalGameRecord): ObjectivePreference | null {
  const { kind, target } = splitAction(actionKey);
  const activeQuestIds = record.state.quests
    .filter((quest) => quest.status === "active")
    .map((quest) => String(quest.questId));
  const activeMainObjective = activeMainObjectiveOf(record);
  const mainObjectiveActionKeys = new Set(
    activeMainObjective === null
      ? []
      : [activeMainObjective.targetActionKey, activeMainObjective.suggestedActionKey]
        .filter((key): key is string => typeof key === "string"),
  );
  if (mainObjectiveActionKeys.has(actionKey)) {
    if (actionKey === activeMainObjective?.targetActionKey) {
      const reasonByKind: Readonly<Record<string, string>> = {
        take_item: "objective:main_item",
        talk: "objective:main_npc",
        move: "objective:main_location",
        investigate: "objective:main_fact",
        start_battle: "objective:main_battle",
      };
      return { tier: 1, reason: reasonByKind[kind] ?? "objective:main" };
    }
    return { tier: 1, reason: "objective:main_route" };
  }
  // 当前 active 主线任务：推进它即推进主线阶段（mainStage）。
  const activeMainQuest = record.blueprint.quests.find(
    (quest) => quest.kind === "main" && activeQuestIds.includes(String(quest.id)),
  );
  const mainTargets = activeMainObjective !== null && activeMainObjective.kind === kind
    ? [activeMainObjective.targetId]
    : activeMainQuest === undefined || activeMainObjective !== null
      ? []
      : objectiveTargetsOf(activeMainQuest.objectives, kind);
  const activeQuestTargets = record.blueprint.quests
    .filter((quest) => activeQuestIds.includes(String(quest.id)))
    .flatMap((quest) => objectiveTargetsOf(quest.objectives, kind));

  if (kind === "take_item") {
    if (mainTargets.includes(target)) return { tier: 1, reason: "objective:main_item" };
    if (activeQuestTargets.includes(target)) return { tier: 2, reason: "objective:quest_item" };
    return { tier: 3, reason: "objective:item" };
  }
  if (kind === "start_battle") {
    if (mainTargets.includes(target)) return { tier: 1, reason: "objective:main_battle" };
    return { tier: 2, reason: "objective:battle" };
  }
  if (kind === "talk") {
    if (mainTargets.includes(target)) return { tier: 1, reason: "objective:main_npc" };
    if (activeQuestTargets.includes(target)) return { tier: 2, reason: "objective:quest_npc" };
    return isExploratory(actionKey, record) ? { tier: 4, reason: "objective:talk" } : { tier: 5, reason: "objective:talk" };
  }
  if (kind === "move") {
    if (mainTargets.includes(target)) return { tier: 1, reason: "objective:main_location" };
    if (activeQuestTargets.includes(target)) return { tier: 2, reason: "objective:quest_location" };
    return isExploratory(actionKey, record) ? { tier: 4, reason: "objective:move" } : { tier: 5, reason: "objective:move" };
  }
  if (kind === "investigate") {
    if (mainTargets.includes(target)) return { tier: 1, reason: "objective:main_fact" };
    if (activeQuestTargets.includes(target)) return { tier: 2, reason: "objective:quest_fact" };
    return isExploratory(actionKey, record) ? { tier: 4, reason: "objective:investigate" } : { tier: 5, reason: "objective:investigate" };
  }
  return null;
}

/**
 * 目标优先选择：比较两个选项的偏好 tier；tier 不同取更优者，tier 相同
 * （同类）才使用同一 PRNG 掷硬币；无偏好动作退回随机。理由记入 story.jsonl。
 */
export function pickObjectiveChoice(
  record: StoryEvalGameRecord,
  rand: () => number,
): { index: 0 | 1; reason: string } {
  const choices = record.state.narrative.currentScene?.choices ?? [];
  if (choices.length !== 2) return { index: 0, reason: "random" };
  const preferences = choices.map((choice) => objectivePreferenceOf(choice.actionKey, record));
  const tierOf = (index: number) => preferences[index]?.tier ?? 99;
  const first = tierOf(0);
  const second = tierOf(1);
  if (first < second) return { index: 0, reason: preferences[0]?.reason ?? "random" };
  if (second < first) return { index: 1, reason: preferences[1]?.reason ?? "random" };
  if (first !== 99) return { index: rand() < 0.5 ? 0 : 1, reason: preferences[0]?.reason ?? "random" };
  return { index: rand() < 0.5 ? 0 : 1, reason: "random" };
}
