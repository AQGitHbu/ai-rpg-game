import type { GameState, NarrativeEventKind, ScenarioBlueprint } from "@/game/domain";
import type { NarrativeActionCandidate, ProposedNewEnemy, ProposedNewFact, ProposedNewItem, ProposedNewLocation, ProposedNewNpc } from "./types";
import type {
  DirectorProposal,
  ApprovedDirectorPlan,
  NarrativeApprovalResult,
} from "./types";
import { deriveContentProgression } from "./contentProgression";

const codePointLength = (value: string) => Array.from(value).length;

const VALID_TENSION_LEVELS = new Set([1, 2, 3, 4, 5]);
const VALID_PACING = new Set(["setup", "develop", "turn", "climax", "resolution"]);

export type { DirectorProposal, ApprovedDirectorPlan };

export type ApproveDirectorProposalInput = {
  readonly proposal: DirectorProposal;
  readonly blueprint: ScenarioBlueprint;
  readonly state: GameState;
  readonly candidates: readonly NarrativeActionCandidate[];
};

export function approveDirectorProposal(
  input: ApproveDirectorProposalInput
): NarrativeApprovalResult<ApprovedDirectorPlan> {
  const { proposal, blueprint, state, candidates } = input;

  // Schema: validate type fields
  if (!VALID_TENSION_LEVELS.has(proposal.tensionLevel)) {
    return { ok: false, category: "schema_violation" };
  }
  if (!VALID_PACING.has(proposal.pacing)) {
    return { ok: false, category: "schema_violation" };
  }
  if (codePointLength(proposal.sceneGoal) < 1 || codePointLength(proposal.sceneGoal) > 200) {
    return { ok: false, category: "schema_violation" };
  }

  // Phase 11 continuity：director 声明的 pacing 必须属于当前主线阶段允许的集合。
  // 这是从权威状态派生的硬约束——不从 narrative prose 推断。违反时整体拒绝，
  // 提案内容不进入返回值；编排层对同场景内的重复 continuity_violation 至多告警一次。
  const progression = deriveContentProgression({ blueprint, state });
  if (!progression.allowedPacing.includes(proposal.pacing)) {
    return { ok: false, category: "continuity_violation" };
  }

  // Reference: all IDs must exist in blueprint
  const allNpcIds = new Set(blueprint.npcs.map((n) => String(n.id)));
  const allFactIds = new Set(blueprint.world.facts.map((f) => String(f.id)));
  const allLocationIds = new Set(blueprint.locations.map((l) => String(l.id)));
  const allItemIds = new Set(blueprint.items.map((i) => String(i.id)));
  const allEnemyIds = new Set(blueprint.enemies.map((e) => String(e.id)));

  // focusNpcId check
  if (proposal.focusNpcId !== null) {
    if (!allNpcIds.has(proposal.focusNpcId)) {
      return { ok: false, category: "reference_broken" };
    }
    // Must be present at current location
    const npcRuntime = state.npcs.find((n) => String(n.npcId) === proposal.focusNpcId);
    if (npcRuntime === undefined || npcRuntime.locationId !== state.currentLocationId) {
      return { ok: false, category: "reference_broken" };
    }
  }

  // relevantFactIds must reference existing facts
  for (const factId of proposal.relevantFactIds) {
    if (!allFactIds.has(factId)) {
      return { ok: false, category: "reference_broken" };
    }
  }

  // allowedRevealFactIds must be discovered
  const discoveredFactIds = new Set(
    state.worldFacts.filter((f) => f.discovered).map((f) => String(f.factId))
  );
  for (const factId of proposal.allowedRevealFactIds) {
    if (!allFactIds.has(factId)) {
      return { ok: false, category: "reference_broken" };
    }
    if (!discoveredFactIds.has(factId)) {
      return { ok: false, category: "reference_broken" };
    }
  }

  // World-event choices need two distinct rule routes. Dialogue events only
  // need one legal candidate as a continuation anchor; the writer supplies
  // two conversational responses that are not action keys.
  const [keyA, keyB] = proposal.suggestedActionKeys;
  const candidateKeys = new Set(candidates.map((c) => c.actionKey));
  // v2.1（R1/Task 2）起 pending 的唯一载体是 job：以 job.actionSummary 派生
  // 对话语义；同时兼容历史 v1 存档/夹具（无 job、仅 triggerContext）的读取。
  const generation = state.narrative?.generation;
  const actionSummary = generation?.status === "pending"
    ? generation.job?.actionSummary
    : undefined;
  const legacyTrigger = generation?.status === "pending"
    ? (generation as { triggerContext?: { kind: string } }).triggerContext
    : undefined;
  const isDialogueEvent = proposal.eventKind === "dialogue" ||
    (proposal.eventKind === undefined && (
      (actionSummary !== undefined &&
        (actionSummary.kind === "talk" || actionSummary.kind === "freeform")) ||
      (legacyTrigger !== undefined &&
        ["initial_opening", "talk", "free_input"].includes(legacyTrigger.kind))
    ));
  if (!candidateKeys.has(keyA) || (!isDialogueEvent && (keyA === keyB || !candidateKeys.has(keyB)))) {
    return { ok: false, category: "choice_not_legal" };
  }

  // introducedEntities must reference existing entities
  for (const entity of proposal.introducedEntities) {
    if (entity.kind === "npc" && !allNpcIds.has(entity.id)) {
      return { ok: false, category: "reference_broken" };
    }
    if (entity.kind === "location" && !allLocationIds.has(entity.id)) {
      return { ok: false, category: "reference_broken" };
    }
    if (entity.kind === "item" && !allItemIds.has(entity.id)) {
      return { ok: false, category: "reference_broken" };
    }
    if (entity.kind === "enemy" && !allEnemyIds.has(entity.id)) {
      return { ok: false, category: "reference_broken" };
    }
    if (entity.kind === "fact" && !allFactIds.has(entity.id)) {
      return { ok: false, category: "reference_broken" };
    }
  }

  if (proposal.eventKind !== undefined) {
    const targetId = proposal.eventTargetId;
    if (proposal.eventKind === "dialogue") {
      if (proposal.focusNpcId === null) return { ok: false, category: "reference_broken" };
    } else {
      const isRuntimeTarget = targetId !== undefined && isAuthorizedRuntimeTarget(proposal.eventKind, targetId, proposal);
      const isExistingTarget = targetId !== undefined && hasEventTarget(proposal.eventKind, targetId, {
        npcIds: allNpcIds,
        factIds: allFactIds,
        itemIds: allItemIds,
        enemyIds: allEnemyIds,
        locationIds: allLocationIds,
      });
      // The event target must also be one of the currently legal rule routes.
      // Otherwise the scene could claim to investigate/take/fight an entity
      // that its choices can never resolve.
      const isLegalExistingRoute = targetId !== undefined &&
        candidateKeys.has(eventActionKeyOf(proposal.eventKind, targetId));
      if (targetId === undefined || (!isRuntimeTarget && (!isExistingTarget || !isLegalExistingRoute))) {
        return { ok: false, category: "reference_broken" };
      }
    }
  }

  // Construct approved object field by field (never return AI object by reference)
  const approved: ApprovedDirectorPlan = {
    sceneGoal: proposal.sceneGoal,
    tensionLevel: proposal.tensionLevel,
    focusNpcId: proposal.focusNpcId,
    relevantFactIds: [...proposal.relevantFactIds],
    allowedRevealFactIds: [...proposal.allowedRevealFactIds],
    suggestedActionKeys: [keyA, candidateKeys.has(keyB) ? keyB : keyA] as readonly [string, string],
    introducedEntities: proposal.introducedEntities.map((e) => ({ ...e })),
    pacing: proposal.pacing,
    proposedNewLocations: rebuildLocationProposals(proposal.proposedNewLocations),
    proposedNewNpcs: rebuildNpcProposals(proposal.proposedNewNpcs),
    proposedNewFacts: rebuildFactProposals(proposal.proposedNewFacts),
    proposedNewItems: rebuildItemProposals(proposal.proposedNewItems),
    proposedNewEnemies: rebuildEnemyProposals(proposal.proposedNewEnemies),
    ...(proposal.eventKind !== undefined ? { eventKind: proposal.eventKind } : {}),
    ...(proposal.eventTargetId !== undefined ? { eventTargetId: proposal.eventTargetId } : {}),
  };

  return { ok: true, value: approved };
}

function isAuthorizedRuntimeTarget(kind: NarrativeEventKind, targetId: string, proposal: DirectorProposal): boolean {
  return kind === "investigate" && targetId === "runtime:new_fact" && proposal.proposedNewFacts?.length === 1 ||
    kind === "item" && targetId === "runtime:new_item" && proposal.proposedNewItems?.length === 1 ||
    kind === "battle" && targetId === "runtime:new_enemy" && proposal.proposedNewEnemies?.length === 1;
}

function hasEventTarget(
  kind: NarrativeEventKind,
  targetId: string,
  ids: Readonly<{
    npcIds: Set<string>;
    factIds: Set<string>;
    itemIds: Set<string>;
    enemyIds: Set<string>;
    locationIds: Set<string>;
  }>
): boolean {
  switch (kind) {
    case "dialogue": return ids.npcIds.has(targetId);
    case "investigate": return ids.factIds.has(targetId);
    case "item": return ids.itemIds.has(targetId);
    case "battle": return ids.enemyIds.has(targetId);
    case "travel":
    case "observe": return ids.locationIds.has(targetId);
  }
}

function eventActionKeyOf(kind: NarrativeEventKind, targetId: string): string {
  switch (kind) {
    case "investigate": return `investigate:${targetId}`;
    case "item": return `take_item:${targetId}`;
    case "battle": return `start_battle:${targetId}`;
    case "travel": return `move:${targetId}`;
    case "observe": return `observe:${targetId}`;
    case "dialogue": return `talk:${targetId}`;
  }
}

// ---------------------------------------------------------------------------
// 丢弃式重建：扩展提案数组任一条目非法（非纯字符串字段对象、scale 非法、
// 数组长度 > 1）→ 整体重建为 []；合法单条目 → 逐字段拷贝重建。
// 扩展问题绝不使场景失败，只丢弃扩展提案本身。
// ---------------------------------------------------------------------------

function rebuildLocationProposals(
  proposals: readonly ProposedNewLocation[] | undefined
): readonly ProposedNewLocation[] {
  if (proposals === undefined || proposals.length > 1) return [];
  if (proposals.length === 0) return [];
  const entry = proposals[0];
  if (
    typeof entry.name !== "string" ||
    typeof entry.description !== "string" ||
    typeof entry.connectFromLocationId !== "string" ||
    typeof entry.reason !== "string" ||
    (entry.scale !== "scene" && entry.scale !== "town")
  ) {
    return [];
  }
  return [{ ...entry }];
}

function rebuildNpcProposals(
  proposals: readonly ProposedNewNpc[] | undefined
): readonly ProposedNewNpc[] {
  if (proposals === undefined || proposals.length > 1) return [];
  if (proposals.length === 0) return [];
  const entry = proposals[0];
  if (
    typeof entry.name !== "string" ||
    typeof entry.role !== "string" ||
    typeof entry.description !== "string" ||
    typeof entry.locationId !== "string"
  ) {
    return [];
  }
  return [{ ...entry }];
}

function rebuildFactProposals(value: readonly ProposedNewFact[] | undefined): readonly ProposedNewFact[] {
  if (value === undefined || value.length !== 1) return [];
  const entry = value[0];
  if (typeof entry.text !== "string" || typeof entry.locationId !== "string" || typeof entry.reason !== "string") return [];
  return [{ text: entry.text, locationId: entry.locationId, reason: entry.reason }];
}

function rebuildItemProposals(value: readonly ProposedNewItem[] | undefined): readonly ProposedNewItem[] {
  if (value === undefined || value.length !== 1) return [];
  const entry = value[0];
  if (typeof entry.name !== "string" || typeof entry.description !== "string" || typeof entry.kind !== "string" || typeof entry.locationId !== "string" || !Array.isArray(entry.tags)) return [];
  return [{ name: entry.name, description: entry.description, kind: entry.kind, locationId: entry.locationId, tags: entry.tags.filter((tag): tag is string => typeof tag === "string") }];
}

function rebuildEnemyProposals(value: readonly ProposedNewEnemy[] | undefined): readonly ProposedNewEnemy[] {
  if (value === undefined || value.length !== 1) return [];
  const entry = value[0];
  if (typeof entry.name !== "string" || typeof entry.locationId !== "string" || typeof entry.reason !== "string" || (entry.tier !== "normal" && entry.tier !== "boss")) return [];
  const stats = entry.stats;
  if (stats === null || typeof stats !== "object" || !Number.isFinite(stats.hp) || !Number.isFinite(stats.attack) || !Number.isFinite(stats.defense)) return [];
  return [{ name: entry.name, tier: entry.tier, locationId: entry.locationId, reason: entry.reason, stats: { hp: stats.hp, attack: stats.attack, defense: stats.defense } }];
}
