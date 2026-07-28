import type {
  EndingRequirement,
  GameEvent,
  GameState,
  ScenarioBlueprint,
} from "@/game/domain";

// ---------------------------------------------------------------------------
// Phase 6：结局 resolver 纯函数。
//
// 在 quest reconciliation/failure 之后运行：检查所有结局的 requirements，
// 全部满足时写入 ending runtime state + ending_reached 事件。
//
// requirement 检查：
//   - quest_completed → quest status 为 completed 或 closed；
//   - quest_failed   → quest status 为 failed；
//   - fact_discovered → worldFacts 中对应事实已发现。
//
// outcome 判定：
//   - 若 requirements 包含 quest_failed → outcome = "failure"；
//   - 否则 → outcome = "success"。
//
// 幂等：已有 ending 时不重复写入。
// 纯函数：不修改输入 state，不依赖 application/repository/UI/Date/Math.random/AI。
// ---------------------------------------------------------------------------

export type ResolveEndingDependencies = {
  /** ISO 8601 时间戳：由 application 层注入，domain 不读时钟。 */
  readonly now: () => string;
};

export type ResolveEndingResult = {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
};

/** 检查单个 ending requirement 是否被当前 state 满足。 */
function isRequirementSatisfied(
  state: GameState,
  requirement: EndingRequirement,
): boolean {
  switch (requirement.kind) {
    case "quest_completed": {
      const questState = state.quests.find((qs) => qs.questId === requirement.questId);
      return questState?.status === "completed" || questState?.status === "closed";
    }
    case "quest_failed": {
      const questState = state.quests.find((qs) => qs.questId === requirement.questId);
      return questState?.status === "failed";
    }
    case "fact_discovered": {
      return state.worldFacts.some(
        (f) => f.factId === requirement.factId && f.discovered,
      );
    }
  }
}

export function resolveEnding(
  blueprint: ScenarioBlueprint,
  state: GameState,
  deps: ResolveEndingDependencies,
): ResolveEndingResult {
  // 幂等：已有 ending 时不重复写入。
  if (state.ending !== null) {
    return { state, events: [] };
  }

  for (const ending of blueprint.endings) {
    const allSatisfied = ending.requirements.every((req) =>
      isRequirementSatisfied(state, req),
    );

    if (!allSatisfied) continue;

    // 判定 outcome：requirements 包含 quest_failed → failure；否则 → success。
    const hasFailedRequirement = ending.requirements.some(
      (req) => req.kind === "quest_failed",
    );
    const outcome = hasFailedRequirement ? "failure" : "success";

    const event: GameEvent = {
      type: "ending_reached",
      endingId: ending.id,
      outcome,
      occurredAt: deps.now(),
    };

    return {
      state: {
        ...state,
        ending: { endingId: ending.id, outcome },
        eventLedger: [...state.eventLedger, event],
      },
      events: [event],
    };
  }

  return { state, events: [] };
}
