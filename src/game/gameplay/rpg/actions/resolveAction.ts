import type { GameEvent, GameState, ScenarioBlueprint } from "@/game/domain";
import type { PlayerIntent } from "./intents";
import {
  validateIntent,
  type ValidateIntentResult,
  type ValidationCode,
} from "./validateIntent";

// ---------------------------------------------------------------------------
// 纯行动 resolver（Phase 3 Task 2）。
//
// 对有效 intent 返回下一份不可变 state、精确事件和确定性反馈；
// 对无效 intent 返回拒绝而不返回 next state。
// 不依赖 application、repository、UI、Date、Math.random 或 AI。
// 事件由 resolver 接受注入的时间产生；domain 不读取时钟。
// ---------------------------------------------------------------------------

export type ActionFeedback = {
  readonly message: string;
};

export type ResolveActionDependencies = {
  /** ISO 8601 时间戳：由 application 层注入，domain 不读时钟。 */
  readonly now: () => string;
};

export type ResolveActionResult =
  | {
      readonly ok: true;
      readonly state: GameState;
      readonly events: readonly GameEvent[];
      readonly feedback: ActionFeedback;
    }
  | {
      readonly ok: false;
      readonly code: ValidationCode;
      readonly params: Record<string, string>;
      readonly feedback: ActionFeedback;
    };

/** 查找地点名称用于反馈文案。 */
function locationName(blueprint: ScenarioBlueprint, locationId: string): string {
  return blueprint.locations.find((l) => l.id === locationId)?.name ?? "未知地点";
}

/** 查找 NPC 名称用于反馈文案。 */
function npcName(blueprint: ScenarioBlueprint, npcId: string): string {
  return blueprint.npcs.find((n) => n.id === npcId)?.name ?? "未知角色";
}

/** 查找事实文本用于反馈文案。 */
function factText(blueprint: ScenarioBlueprint, factId: string): string {
  return blueprint.world.facts.find((f) => f.id === factId)?.text ?? "未知线索";
}

/** 查找物品名称用于反馈文案。 */
function itemName(blueprint: ScenarioBlueprint, itemId: string): string {
  return blueprint.items.find((i) => i.id === itemId)?.name ?? "未知物品";
}

/** 根据校验失败码生成确定性反馈。 */
function rejectionFeedback(
  blueprint: ScenarioBlueprint,
  result: Extract<ValidateIntentResult, { ok: false }>,
): ActionFeedback {
  switch (result.code) {
    case "LOCATION_NOT_CURRENT":
      return { message: "你只能观察当前所在的地点。" };
    case "UNKNOWN_LOCATION":
      return { message: "未知地点。" };
    case "LOCATION_ALREADY_OBSERVED":
      return { message: "你已经观察过这里了。" };
    case "LOCATION_ALREADY_CURRENT":
      return { message: "你已经在这里了。" };
    case "LOCATION_NOT_CONNECTED":
      return { message: "从这里无法直接前往目标地点。" };
    case "LOCATION_LOCKED":
      return { message: "目标地点尚未解锁。" };
    case "NPC_NOT_PRESENT":
      return { message: `${npcName(blueprint, result.params.npcId)}不在当前地点。` };
    case "UNKNOWN_NPC":
      return { message: "未知角色。" };
    case "NPC_ALREADY_MET":
      return { message: `你已经与${npcName(blueprint, result.params.npcId)}交谈过了。` };
    case "FACT_NOT_INVESTIGABLE":
      return { message: "这个线索无法在当前场景调查。" };
    case "UNKNOWN_FACT":
      return { message: "未知线索。" };
    case "FACT_ALREADY_DISCOVERED":
      return { message: "你已经调查过这个线索了。" };
    case "UNKNOWN_ITEM":
      return { message: "未知物品。" };
    case "ITEM_NOT_AVAILABLE_HERE":
      return { message: "这里没有这件物品。" };
    case "ITEM_ALREADY_OWNED":
      return { message: `你已经持有${itemName(blueprint, result.params.itemId)}了。` };
  }
}

/** 不可变更新：替换数组中匹配元素。 */
function replaceInArray<T>(array: readonly T[], predicate: (item: T) => boolean, replacement: (item: T) => T): T[] {
  return array.map((item) => (predicate(item) ? replacement(item) : item));
}

export function resolveAction(
  blueprint: ScenarioBlueprint,
  state: GameState,
  intent: PlayerIntent,
  deps: ResolveActionDependencies,
): ResolveActionResult {
  const validation = validateIntent(blueprint, state, intent);
  if (!validation.ok) {
    return {
      ok: false,
      code: validation.code,
      params: validation.params,
      feedback: rejectionFeedback(blueprint, validation),
    };
  }

  const occurredAt = deps.now();

  switch (intent.type) {
    case "observe": {
      const event: GameEvent = {
        type: "location_observed",
        locationId: intent.locationId,
        occurredAt,
      };
      const newState: GameState = {
        ...state,
        eventLedger: [...state.eventLedger, event],
      };
      return {
        ok: true,
        state: newState,
        events: [event],
        feedback: { message: `你仔细观察了${locationName(blueprint, intent.locationId)}。` },
      };
    }

    case "talk": {
      const event: GameEvent = {
        type: "npc_met",
        npcId: intent.npcId,
        occurredAt,
      };
      const newState: GameState = {
        ...state,
        npcs: replaceInArray(
          state.npcs,
          (n) => n.npcId === intent.npcId,
          (n) => ({ ...n, met: true }),
        ),
        eventLedger: [...state.eventLedger, event],
      };
      return {
        ok: true,
        state: newState,
        events: [event],
        feedback: { message: `你与${npcName(blueprint, intent.npcId)}交谈，初次见面。` },
      };
    }

    case "investigate": {
      const event: GameEvent = {
        type: "fact_discovered",
        factId: intent.factId,
        occurredAt,
      };
      const newState: GameState = {
        ...state,
        worldFacts: replaceInArray(
          state.worldFacts,
          (f) => f.factId === intent.factId,
          (f) => ({ ...f, discovered: true }),
        ),
        eventLedger: [...state.eventLedger, event],
      };
      return {
        ok: true,
        state: newState,
        events: [event],
        feedback: { message: `你调查了${factText(blueprint, intent.factId)}。` },
      };
    }

    case "move": {
      const event: GameEvent = {
        type: "location_visited",
        locationId: intent.locationId,
        occurredAt,
      };
      const newState: GameState = {
        ...state,
        currentLocationId: intent.locationId,
        // 到访事实去重记录：重复到访只追加事件，不重复登记地点。
        visitedLocationIds: state.visitedLocationIds.includes(intent.locationId)
          ? state.visitedLocationIds
          : [...state.visitedLocationIds, intent.locationId],
        eventLedger: [...state.eventLedger, event],
      };
      return {
        ok: true,
        state: newState,
        events: [event],
        feedback: { message: `你来到了${locationName(blueprint, intent.locationId)}。` },
      };
    }

    case "take_item": {
      const event: GameEvent = {
        type: "item_obtained",
        itemId: intent.itemId,
        locationId: state.currentLocationId,
        occurredAt,
      };
      const newState: GameState = {
        ...state,
        // 只把物品 ID 加入背包；不改数值、NPC、任务或地点。
        inventory: [...state.inventory, intent.itemId],
        eventLedger: [...state.eventLedger, event],
      };
      return {
        ok: true,
        state: newState,
        events: [event],
        feedback: { message: `你取得了${itemName(blueprint, intent.itemId)}。` },
      };
    }
  }
}
