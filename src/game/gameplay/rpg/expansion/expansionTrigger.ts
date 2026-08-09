import type { WorldState, NpcEntry } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { Action } from "@/game/domain/action";
import type { RuleEngineResult, ValidationCode } from "@/game/gameplay/rpg/ruleEngine";
import { budgetAllowsExpansion, withinHardLimit } from "@/game/domain/storyBudget";
import type { ExpansionTriggerReason, ExpansionClosureSignal, ExpansionReuse } from "./expansionTypes";

const ENTITY_NOT_FOUND_CODES: ReadonlySet<ValidationCode> = new Set([
  "UNKNOWN_LOCATION",
  "UNKNOWN_NPC",
  "UNKNOWN_FACT",
  "UNKNOWN_ITEM",
  "UNKNOWN_ENEMY",
]);

/** 张力低于该阈值视为“持续低张力”，可触发世界扩张（Spec §15.2-2）。 */
const LOW_TENSION_THRESHOLD = 20;

/** 已在场的、可被复用为任务角色的 NPC 角色关键词（用于 quest_gap 复用判定）。 */
const REUSABLE_ROLE_HINTS: ReadonlyArray<string> = [
  "守卫", "商人", "老者", "猎人", "佣兵", "神秘",
  "guard", "merchant", "elder", "hunter",
];

export type TriggerResult = {
  readonly triggered: boolean;
  readonly reason: ExpansionTriggerReason | "no_trigger";
  /** 已有合适实体可复用（不新建），由调用方决定用该实体重演算。 */
  readonly reuse?: ExpansionReuse;
  /** 收束信号：climax/resolve、soft max、hard limit 或预算耗尽，本轮不扩张。 */
  readonly closureSignal?: ExpansionClosureSignal;
};

/**
 * 纯函数触发判定（Spec §15.2）：
 * 1. entity_not_found：目标实体不存在且预算允许 → 扩张（player 明确指向具体
 *    不存在实体时，无法可靠判定“可复用”，故创建新实体以满足行动）。
 * 2. 持续低张力且无可复用敌对势力、预算允许、非 climax/resolve → low_tension；
 *    若已有可复用敌对势力 → 返回 reuse（不新建）。
 * 3. 主线任务目标存在实体角色缺口 → quest_gap；若存在可复用角色 → 返回 reuse。
 * 收束：climax/resolve、soft max、hard limit、预算耗尽 → 不触发并给出 closureSignal。
 * 不读取时钟/随机数/IO；不执行 AI source（由 application 编排）。
 */
export function checkExpansionTrigger(
  initialResult: RuleEngineResult,
  ws: WorldState,
  ss: StoryState,
  _action: Action,
): TriggerResult {
  // 收束信号优先：climax/resolve 阶段与硬上限阶段绝不扩张
  const closure = closureSignalFor(ss);
  if (closure) {
    return { triggered: false, reason: "no_trigger", closureSignal: closure };
  }

  // 1) 目标实体不存在 → 扩张（创建新实体以满足明确的行动目标）
  if (!initialResult.ok && ENTITY_NOT_FOUND_CODES.has(initialResult.code)) {
    const budgetDim = budgetDimForCode(initialResult.code);
    if (budgetDim !== null && !budgetAllowsExpansion(ss.budget, budgetDim)) {
      return { triggered: false, reason: "no_trigger", closureSignal: "budget_exhausted" };
    }
    return { triggered: true, reason: "entity_not_found" };
  }

  // 成功路径才评估低张力 / 任务缺口
  if (!initialResult.ok) {
    return { triggered: false, reason: "no_trigger" };
  }

  // 2) 持续低张力：有可复用敌对势力 → reuse；无可复用 → 新建敌对/张力实体
  if (
    ss.tension < LOW_TENSION_THRESHOLD &&
    ss.currentAct >= 2 &&
    ss.nextPacingNeed !== "climax" &&
    ss.nextPacingNeed !== "resolve" &&
    hasExpansionBudgetForPacing(ss)
  ) {
    const hostileReuse = reusableHostileEntity(ws);
    if (hostileReuse) {
      return { triggered: true, reason: "reuse", reuse: hostileReuse };
    }
    return { triggered: true, reason: "low_tension" };
  }

  // 3) 主线目标实体角色缺口：存在可复用角色 → reuse；否则 → quest_gap
  const gapReuse = mainQuestRoleGapReuse(ws);
  if (gapReuse) {
    return { triggered: true, reason: "reuse", reuse: gapReuse };
  }
  if (mainQuestHasRoleGap(ws)) {
    return { triggered: true, reason: "quest_gap" };
  }

  return { triggered: false, reason: "no_trigger" };
}

function closureSignalFor(ss: StoryState): ExpansionClosureSignal | null {
  if (ss.nextPacingNeed === "climax" || ss.nextPacingNeed === "resolve") {
    return "climax";
  }
  if (!withinHardLimit(ss.budget, "npcs") || !withinHardLimit(ss.budget, "locations")) {
    return "hard_limit";
  }
  return null;
}

function budgetDimForCode(code: ValidationCode): "locations" | "npcs" | "quests" | "events" | null {
  switch (code) {
    case "UNKNOWN_LOCATION": return "locations";
    case "UNKNOWN_NPC": return "npcs";
    default: return null;
  }
}

function hasExpansionBudgetForPacing(ss: StoryState): boolean {
  return (
    budgetAllowsExpansion(ss.budget, "npcs") ||
    budgetAllowsExpansion(ss.budget, "locations") ||
    budgetAllowsExpansion(ss.budget, "events")
  );
}

/** 低张力触发时，是否已有可复用的敌对实体（enemy 或敌对阵营）。 */
function reusableHostileEntity(ws: WorldState): ExpansionReuse | undefined {
  const enemy = ws.enemies.find((e) => !ws.defeatedEnemyIds.includes(e.id));
  if (enemy) return { kind: "enemy", id: String(enemy.id) };
  const hostileFaction = ws.factions.find((f) => f.attitudeToPlayer < 0);
  if (hostileFaction) return { kind: "faction", id: String(hostileFaction.factionId) };
  return undefined;
}

/** 主线任务角色缺口是否可由已有 NPC 复用。 */
function mainQuestRoleGapReuse(ws: WorldState): ExpansionReuse | undefined {
  const activeMain = ws.quests.filter((q) => q.kind === "main" && q.status === "active");
  if (activeMain.length === 0) return undefined;
  for (const quest of activeMain) {
    for (const obj of quest.objectives) {
      if (obj.kind === "talk_to_npc" && !ws.npcs.some((n) => n.id === obj.npcId)) {
        // 找一个角色语义接近、且目前可被重定向的 NPC（未在本任务的 npcIds 中固定）
        const candidate = ws.npcs.find((n) => roleMatchesHint(n));
        if (candidate) return { kind: "npc", id: String(candidate.id) };
        return undefined;
      }
      if (obj.kind === "defeat_enemy" && !ws.enemies.some((e) => e.id === obj.enemyId)) {
        const candidate = ws.enemies.find((e) => !ws.defeatedEnemyIds.includes(e.id));
        if (candidate) return { kind: "enemy", id: String(candidate.id) };
        return undefined;
      }
    }
  }
  return undefined;
}

function roleMatchesHint(npc: NpcEntry): boolean {
  const haystack = `${npc.name} ${npc.role} ${npc.description}`.toLowerCase();
  return REUSABLE_ROLE_HINTS.some((h) => haystack.includes(h.toLowerCase()));
}

/** 主线任务目标是否引用一个世界不存在 / 无法满足的实体（角色缺口）。 */
function mainQuestHasRoleGap(ws: WorldState): boolean {
  const activeMain = ws.quests.filter((q) => q.kind === "main" && q.status === "active");
  if (activeMain.length === 0) return false;
  for (const quest of activeMain) {
    for (const obj of quest.objectives) {
      if (obj.kind === "talk_to_npc" && !ws.npcs.some((n) => n.id === obj.npcId)) return true;
      if (obj.kind === "defeat_enemy" && !ws.enemies.some((e) => e.id === obj.enemyId)) return true;
      if (obj.kind === "visit_location" && !ws.locations.some((l) => l.id === obj.locationId)) return true;
      if (obj.kind === "obtain_item" && !ws.items.some((i) => i.id === obj.itemId)) return true;
    }
  }
  return false;
}
