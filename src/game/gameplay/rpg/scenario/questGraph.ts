import {
  type EndingDefinitionCandidate,
  type QuestDefinitionCandidate,
  type QuestOutcomeCandidate
} from "@/game/domain";

// ---------------------------------------------------------------------------
// 任务图校验与结局可达性分析（Task 4）。
//
// 图语义：任务是节点，onSuccess / onFailure 各定义一组出边：
//   - unlock_quests → 指向被解锁任务的边；
//   - reach_ending  → 指向结局（终点）；
//   - closed        → 显式关闭（终点）。
// 可达性分析中成功与失败路径同样可走。
//
// 初始节点规则：唯一的 stage === 1 主线任务。缺失或多个都视为非法，
// 此时可达性分析退化为“无起点”（全部节点不可达），但 SCC 分析仍全局执行。
//
// 关闭语义：任一 outcome 为 reach_ending 或 closed 即算该节点可直接关闭；
// reach_ending 指向不存在的结局仍算关闭（悬空引用由 DANGLING_ENDING_REF 单独拒绝）。
// ---------------------------------------------------------------------------

export type QuestGraphIssueCode =
  | "DUPLICATE_QUEST_ID"
  | "DUPLICATE_ENDING_ID"
  | "DANGLING_QUEST_REF"
  | "DANGLING_ENDING_REF"
  | "UNKNOWN_OBJECTIVE_TARGET"
  | "INVALID_OBJECTIVE"
  | "INVALID_OUTCOME"
  | "NO_INITIAL_MAIN_QUEST"
  | "MULTIPLE_INITIAL_MAIN_QUESTS"
  | "MISSING_MAIN_STAGE"
  | "LOOP_WITHOUT_CLOSURE"
  | "UNREACHABLE_ENDING"
  | "ENDING_COUNT_MISMATCH"
  | "INVALID_MAIN_STAGE"
  | "MAIN_STAGE_OVERBUDGET"
  | "SIDE_QUEST_OVERBUDGET"
  | "REPEATED_MAIN_OBJECTIVE";

export type QuestGraphIssue = {
  path: string;
  code: QuestGraphIssueCode;
  params: Record<string, string | number>;
};

/** objective 引用检查所需的已知实体 ID 集合，由调用方（Task 5）从候选蓝图收集。 */
export type QuestGraphKnownEntityIds = {
  locationIds: readonly string[];
  npcIds: readonly string[];
  itemIds: readonly string[];
  factIds: readonly string[];
  enemyIds: readonly string[];
};

export type QuestGraphInput = {
  quests: readonly QuestDefinitionCandidate[];
  endings: readonly EndingDefinitionCandidate[];
  knownEntityIds: QuestGraphKnownEntityIds;
  budget: { readonly mainActs: number; readonly sideQuestsMax: number; readonly endings: number };
};

export type QuestReachabilityAnalysis = {
  /** 唯一 stage 1 主线任务的 ID；缺失或多个时为 null。 */
  initialQuestId: string | null;
  /** 从初始节点沿成功/失败出边可达的任务，按 quests 数组顺序。 */
  reachableQuestIds: readonly string[];
  /** 其余任务，按 quests 数组顺序。 */
  unreachableQuestIds: readonly string[];
  /** 可达任务经 reach_ending 抵达且真实存在的结局，按 endings 数组顺序。 */
  reachableEndingIds: readonly string[];
  /** 含环且无法抵达任何 reach_ending/closed 的强连通区域，组内与组间均按 quests 数组顺序。 */
  loopsWithoutClosure: readonly (readonly string[])[];
};

const OUTCOME_FIELDS = ["onSuccess", "onFailure"] as const;

/**
 * 纯函数：任务图可达性与无关闭闭环分析。
 * 不读配置、不取时间/随机/环境；重复任务 ID 以首次出现为准（重复由校验单独拒绝）。
 */
export function analyzeQuestReachability(
  quests: readonly QuestDefinitionCandidate[],
  endings: readonly EndingDefinitionCandidate[]
): QuestReachabilityAnalysis {
  const questIndex = buildQuestIndex(quests);
  const orderedIds = [...questIndex.keys()];
  const initialQuestId = findInitialQuestId(questIndex);

  const reachable = new Set<string>();
  const reachedEndingIds = new Set<string>();
  if (initialQuestId !== null) {
    const pending = [initialQuestId];
    reachable.add(initialQuestId);
    while (pending.length > 0) {
      const quest = questIndex.get(pending.shift() as string) as QuestDefinitionCandidate;
      for (const field of OUTCOME_FIELDS) {
        const outcome = quest[field] as QuestOutcomeCandidate | undefined;
        if (outcome?.kind === "reach_ending") {
          reachedEndingIds.add(outcome.endingId);
        } else if (outcome?.kind === "unlock_quests") {
          for (const questId of outcome.questIds ?? []) {
            if (questIndex.has(questId) && !reachable.has(questId)) {
              reachable.add(questId);
              pending.push(questId);
            }
          }
        }
      }
    }
  }

  // 结局按 endings 数组顺序输出；重复 ID（由校验单独拒绝）只输出一次。
  const emittedEndingIds = new Set<string>();
  const reachableEndingIds: string[] = [];
  for (const endingDef of endings) {
    if (reachedEndingIds.has(endingDef.id) && !emittedEndingIds.has(endingDef.id)) {
      emittedEndingIds.add(endingDef.id);
      reachableEndingIds.push(endingDef.id);
    }
  }
  return {
    initialQuestId,
    reachableQuestIds: orderedIds.filter((id) => reachable.has(id)),
    unreachableQuestIds: orderedIds.filter((id) => !reachable.has(id)),
    reachableEndingIds,
    loopsWithoutClosure: findLoopsWithoutClosure(questIndex, orderedIds)
  };
}

/**
 * 任务图校验：返回结构化问题列表，空数组即通过。
 * 不抛异常——候选来自 AI/JSON，由 Task 5 聚合全部问题后决定修复或 fallback。
 */
export function validateQuestGraph(input: QuestGraphInput): readonly QuestGraphIssue[] {
  const { quests, endings, knownEntityIds, budget } = input;
  const issues: QuestGraphIssue[] = [];

  const questIds = collectUniqueIds(issues, quests, "quests", "DUPLICATE_QUEST_ID");
  const endingIds = collectUniqueIds(issues, endings, "endings", "DUPLICATE_ENDING_ID");

  const known = {
    visit_location: { key: "locationId", ids: new Set(knownEntityIds.locationIds) },
    talk_to_npc: { key: "npcId", ids: new Set(knownEntityIds.npcIds) },
    obtain_item: { key: "itemId", ids: new Set(knownEntityIds.itemIds) },
    discover_fact: { key: "factId", ids: new Set(knownEntityIds.factIds) },
    defeat_enemy: { key: "enemyId", ids: new Set(knownEntityIds.enemyIds) }
  } as const;

  quests.forEach((quest, index) => {
    const path = `quests[${index}]`;
    for (const field of OUTCOME_FIELDS) {
      validateOutcome(issues, `${path}.${field}`, quest, quest[field], questIds, endingIds);
    }
    (quest.objectives ?? []).forEach((objective, objectiveIndex) => {
      const objectivePath = `${path}.objectives[${objectiveIndex}]`;
      const spec = known[objective.kind as keyof typeof known];
      if (spec === undefined) {
        issues.push({
          path: objectivePath,
          code: "INVALID_OBJECTIVE",
          params: { kind: String((objective as { kind?: unknown }).kind ?? "") }
        });
        return;
      }
      const targetId = (objective as unknown as Record<string, string>)[spec.key];
      if (!spec.ids.has(targetId)) {
        issues.push({
          path: objectivePath,
          code: "UNKNOWN_OBJECTIVE_TARGET",
          params: { kind: objective.kind, targetId }
        });
      }
    });
  });

  validateMainObjectiveProgression(issues, quests);
  validateStructure(issues, quests, endings, budget);
  validateReachability(issues, quests, endings);
  return issues;
}

// ---------------------------------------------------------------------------
// 校验子步骤
// ---------------------------------------------------------------------------

function collectUniqueIds(
  issues: QuestGraphIssue[],
  entries: readonly { readonly id: string }[],
  path: string,
  code: "DUPLICATE_QUEST_ID" | "DUPLICATE_ENDING_ID"
): ReadonlySet<string> {
  const ids = new Set<string>();
  entries.forEach((entry, index) => {
    if (ids.has(entry.id)) {
      issues.push({ path: `${path}[${index}].id`, code, params: { id: entry.id } });
    }
    ids.add(entry.id);
  });
  return ids;
}

/** outcome 运行时防御：候选来自 JSON，类型层的三选一封闭 union 可能被破坏。 */
function validateOutcome(
  issues: QuestGraphIssue[],
  path: string,
  quest: QuestDefinitionCandidate,
  outcome: QuestOutcomeCandidate | undefined,
  questIds: ReadonlySet<string>,
  endingIds: ReadonlySet<string>
): void {
  if (outcome?.kind === "closed") return;
  if (outcome?.kind === "reach_ending" && typeof outcome.endingId === "string") {
    if (!endingIds.has(outcome.endingId)) {
      issues.push({
        path: `${path}.endingId`,
        code: "DANGLING_ENDING_REF",
        params: { endingId: outcome.endingId }
      });
    }
    return;
  }
  if (outcome?.kind === "unlock_quests" && Array.isArray(outcome.questIds)) {
    if (outcome.questIds.length === 0) {
      // 空解锁列表 = 无出边的死局：不构成自环，SCC 闭环检查不会命中，必须在此拒绝。
      issues.push({ path, code: "INVALID_OUTCOME", params: { questId: quest.id, reason: "empty_unlock_list" } });
      return;
    }
    outcome.questIds.forEach((questId, index) => {
      if (!questIds.has(questId)) {
        issues.push({
          path: `${path}.questIds[${index}]`,
          code: "DANGLING_QUEST_REF",
          params: { questId }
        });
      }
    });
    return;
  }
  issues.push({ path, code: "INVALID_OUTCOME", params: { questId: quest.id } });
}

/**
 * State-backed objectives are monotonic facts: once a location is visited,
 * NPC met, item obtained, fact discovered, or enemy defeated, the same target
 * cannot become a meaningful new gate for a later unlocked main quest. Reject
 * duplicate kind+target signatures so a generated blueprint cannot skip whole
 * acts through reconciliation's fixed-point loop.
 */
function validateMainObjectiveProgression(
  issues: QuestGraphIssue[],
  quests: readonly QuestDefinitionCandidate[],
): void {
  const seen = new Map<string, { readonly stage: number; readonly path: string }>();
  quests
    .map((quest, index) => ({ quest, index }))
    .filter((entry): entry is { readonly quest: Extract<QuestDefinitionCandidate, { readonly kind: "main" }>; readonly index: number } => entry.quest.kind === "main")
    .sort((left, right) => left.quest.stage - right.quest.stage)
    .forEach(({ quest, index }) => {
      quest.objectives.forEach((objective, objectiveIndex) => {
        const signature = mainObjectiveSignature(objective);
        const previous = seen.get(signature);
        if (previous !== undefined) {
          issues.push({
            path: `quests[${index}].objectives[${objectiveIndex}]`,
            code: "REPEATED_MAIN_OBJECTIVE",
            params: {
              stage: quest.stage,
              previousStage: previous.stage,
              signature,
            },
          });
          return;
        }
        seen.set(signature, {
          stage: quest.stage,
          path: `quests[${index}].objectives[${objectiveIndex}]`,
        });
      });
    });
}

function mainObjectiveSignature(objective: QuestDefinitionCandidate["objectives"][number]): string {
  switch (objective.kind) {
    case "visit_location": return `${objective.kind}:${objective.locationId}`;
    case "talk_to_npc": return `${objective.kind}:${objective.npcId}`;
    case "obtain_item": return `${objective.kind}:${objective.itemId}`;
    case "discover_fact": return `${objective.kind}:${objective.factId}`;
    case "defeat_enemy": return `${objective.kind}:${objective.enemyId}`;
  }
}

/** 初始节点唯一性、主线阶段/支线预算与结局数量。 */
function validateStructure(
  issues: QuestGraphIssue[],
  quests: readonly QuestDefinitionCandidate[],
  endings: readonly EndingDefinitionCandidate[],
  budget: { readonly mainActs: number; readonly sideQuestsMax: number; readonly endings: number }
): void {
  const stageCounts = new Map<number, number>();
  let sideCount = 0;
  quests.forEach((quest, index) => {
    if (quest.kind === "side") {
      sideCount += 1;
      return;
    }
    const stage = quest.stage as number;
    if (!Number.isInteger(stage) || stage < 1 || stage > budget.mainActs) {
      issues.push({
        path: `quests[${index}].stage`,
        code: "INVALID_MAIN_STAGE",
        params: { questId: quest.id, stage: String(stage) }
      });
      return;
    }
    stageCounts.set(stage, (stageCounts.get(stage) ?? 0) + 1);
  });

  const initialCount = stageCounts.get(1) ?? 0;
  if (initialCount === 0) {
    issues.push({ path: "quests", code: "NO_INITIAL_MAIN_QUEST", params: {} });
  } else if (initialCount > 1) {
    issues.push({ path: "quests", code: "MULTIPLE_INITIAL_MAIN_QUESTS", params: { count: initialCount } });
  }
  for (let act = 1; act <= budget.mainActs; act++) {
    const count = stageCounts.get(act) ?? 0;
    if (count === 0 && act !== 1) {
      issues.push({ path: "quests", code: "MISSING_MAIN_STAGE", params: { stage: act } });
    }
    if (count > 1) {
      issues.push({ path: "quests", code: "MAIN_STAGE_OVERBUDGET", params: { stage: act, count } });
    }
  }
  if (sideCount > budget.sideQuestsMax) {
    issues.push({
      path: "quests",
      code: "SIDE_QUEST_OVERBUDGET",
      params: { count: sideCount, max: budget.sideQuestsMax }
    });
  }
  if (endings.length !== budget.endings) {
    issues.push({
      path: "endings",
      code: "ENDING_COUNT_MISMATCH",
      params: { count: endings.length, expected: budget.endings }
    });
  }
}

/** 基于 analyzeQuestReachability：无关闭闭环总是拒绝；结局可达性仅在存在唯一初始节点时检查，避免连带噪音。 */
function validateReachability(
  issues: QuestGraphIssue[],
  quests: readonly QuestDefinitionCandidate[],
  endings: readonly EndingDefinitionCandidate[]
): void {
  const analysis = analyzeQuestReachability(quests, endings);
  for (const loop of analysis.loopsWithoutClosure) {
    issues.push({ path: "quests", code: "LOOP_WITHOUT_CLOSURE", params: { questIds: loop.join(",") } });
  }
  if (analysis.initialQuestId === null) return;
  const reachableEndings = new Set(analysis.reachableEndingIds);
  endings.forEach((endingDef, index) => {
    if (!reachableEndings.has(endingDef.id)) {
      issues.push({
        path: `endings[${index}]`,
        code: "UNREACHABLE_ENDING",
        params: { endingId: endingDef.id }
      });
    }
  });
}

// ---------------------------------------------------------------------------
// 图工具
// ---------------------------------------------------------------------------

/** 按首次出现建立 id → quest 索引（Map 保持插入序，保证输出稳定）。 */
function buildQuestIndex(
  quests: readonly QuestDefinitionCandidate[]
): Map<string, QuestDefinitionCandidate> {
  const index = new Map<string, QuestDefinitionCandidate>();
  for (const quest of quests) {
    if (!index.has(quest.id)) index.set(quest.id, quest);
  }
  return index;
}

function findInitialQuestId(questIndex: ReadonlyMap<string, QuestDefinitionCandidate>): string | null {
  const initialIds: string[] = [];
  for (const quest of questIndex.values()) {
    if (quest.kind === "main" && (quest.stage as number) === 1) initialIds.push(quest.id);
  }
  return initialIds.length === 1 ? initialIds[0] : null;
}

function unlockTargets(
  quest: QuestDefinitionCandidate,
  questIndex: ReadonlyMap<string, QuestDefinitionCandidate>
): string[] {
  const targets: string[] = [];
  for (const field of OUTCOME_FIELDS) {
    const outcome = quest[field] as QuestOutcomeCandidate | undefined;
    if (outcome?.kind !== "unlock_quests") continue;
    for (const questId of outcome.questIds ?? []) {
      if (questIndex.has(questId)) targets.push(questId);
    }
  }
  return targets;
}

function closesDirectly(quest: QuestDefinitionCandidate): boolean {
  return OUTCOME_FIELDS.some((field) => {
    const kind = (quest[field] as QuestOutcomeCandidate | undefined)?.kind;
    return kind === "reach_ending" || kind === "closed";
  });
}

/**
 * Tarjan SCC + 缩点闭包传播：返回“含环且无可达关闭”的强连通区域。
 * Tarjan 按逆拓扑序产出 SCC（后继先出栈），因此可在产出时直接向前传播 canClose。
 */
function findLoopsWithoutClosure(
  questIndex: ReadonlyMap<string, QuestDefinitionCandidate>,
  orderedIds: readonly string[]
): readonly (readonly string[])[] {
  const indexOf = new Map<string, number>();
  orderedIds.forEach((id, position) => indexOf.set(id, position));

  const lowLink = new Map<string, number>();
  const discovery = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccOf = new Map<string, number>();
  const sccMembers: string[][] = [];
  const sccCanClose: boolean[] = [];
  let nextDiscovery = 0;

  // 迭代式 Tarjan，避免大图递归爆栈。
  const visit = (rootId: string): void => {
    const frames: { id: string; targets: string[]; next: number }[] = [
      { id: rootId, targets: unlockTargets(questIndex.get(rootId) as QuestDefinitionCandidate, questIndex), next: 0 }
    ];
    discovery.set(rootId, nextDiscovery);
    lowLink.set(rootId, nextDiscovery);
    nextDiscovery += 1;
    stack.push(rootId);
    onStack.add(rootId);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame.next < frame.targets.length) {
        const targetId = frame.targets[frame.next];
        frame.next += 1;
        if (!discovery.has(targetId)) {
          discovery.set(targetId, nextDiscovery);
          lowLink.set(targetId, nextDiscovery);
          nextDiscovery += 1;
          stack.push(targetId);
          onStack.add(targetId);
          frames.push({
            id: targetId,
            targets: unlockTargets(questIndex.get(targetId) as QuestDefinitionCandidate, questIndex),
            next: 0
          });
        } else if (onStack.has(targetId)) {
          lowLink.set(frame.id, Math.min(lowLink.get(frame.id) as number, discovery.get(targetId) as number));
        }
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent !== undefined) {
        lowLink.set(parent.id, Math.min(lowLink.get(parent.id) as number, lowLink.get(frame.id) as number));
      }
      if (lowLink.get(frame.id) !== discovery.get(frame.id)) continue;
      // frame.id 是一个 SCC 的根：弹出成员并立即计算 canClose（后继 SCC 已完成）。
      const members: string[] = [];
      let popped: string;
      do {
        popped = stack.pop() as string;
        onStack.delete(popped);
        members.push(popped);
      } while (popped !== frame.id);
      const sccId = sccMembers.length;
      for (const member of members) sccOf.set(member, sccId);
      let canClose = false;
      for (const member of members) {
        const quest = questIndex.get(member) as QuestDefinitionCandidate;
        if (closesDirectly(quest)) canClose = true;
        for (const targetId of unlockTargets(quest, questIndex)) {
          const targetScc = sccOf.get(targetId) as number;
          if (targetScc !== sccId && sccCanClose[targetScc]) canClose = true;
        }
      }
      sccMembers.push(members);
      sccCanClose.push(canClose);
    }
  };

  for (const id of orderedIds) {
    if (!discovery.has(id)) visit(id);
  }

  const loops: string[][] = [];
  sccMembers.forEach((members, sccId) => {
    if (sccCanClose[sccId]) return;
    const hasSelfLoop =
      members.length === 1 &&
      unlockTargets(questIndex.get(members[0]) as QuestDefinitionCandidate, questIndex).includes(members[0]);
    if (members.length > 1 || hasSelfLoop) {
      loops.push([...members].sort((a, b) => (indexOf.get(a) as number) - (indexOf.get(b) as number)));
    }
  });
  loops.sort((a, b) => (indexOf.get(a[0]) as number) - (indexOf.get(b[0]) as number));
  return loops;
}
