import type { EndingRequirement } from "./worldEntries";
import type { WorldState } from "./worldState";
import { entitiesOfKind, validateEntityStoreStructure } from "./entity/entityStore";
import { validateEntityReferences } from "./entity/entityProjection";

// ---------------------------------------------------------------------------
// WorldState 层引用校验：battle 与 endings 对 Entity 的权威引用不在 store 内，
// store-only validator 看不到它们，战败恢复与结局判定却完全依赖这些 ID。
// 本文件可以 import WorldState 与 entity selector；entity/** 不得反向 import 它。
// ---------------------------------------------------------------------------

export type WorldStateEntityReferenceIssue = Readonly<{
  code:
    | "unknown_battle_enemy_ref"
    | "unknown_battle_combatant_enemy_ref"
    | "invalid_battle_snapshot"
    | "unknown_ending_requirement_ref"
    | "unknown_resolved_ending_ref";
  entityId: string;
  referencedId?: string;
}>;

type KnownBattleIds = ReadonlySet<string>;

function battleIssues(worldState: WorldState, enemies: KnownBattleIds): readonly WorldStateEntityReferenceIssue[] {
  const battle = worldState.battle;
  if (battle.status === "idle") return [];
  const issues: WorldStateEntityReferenceIssue[] = [];
  const battleEntityId = battle.enemyId;
  if (!enemies.has(battle.enemyId)) {
    issues.push({ code: "unknown_battle_enemy_ref", entityId: battleEntityId, referencedId: battle.enemyId });
  }
  if (battle.status === "resolved") return issues;

  for (const enemyId of battle.enemyIds ?? []) {
    if (!enemies.has(enemyId)) {
      issues.push({ code: "unknown_battle_enemy_ref", entityId: battleEntityId, referencedId: enemyId });
    }
  }
  for (const enemyId of battle.downedEnemyIds ?? []) {
    if (!enemies.has(enemyId)) {
      issues.push({ code: "unknown_battle_enemy_ref", entityId: battleEntityId, referencedId: enemyId });
    }
  }
  for (const combatant of battle.combatants ?? []) {
    if (combatant.source.kind === "enemy" && !enemies.has(combatant.source.enemyId)) {
      issues.push({
        code: "unknown_battle_combatant_enemy_ref",
        entityId: combatant.combatantId,
        referencedId: combatant.source.enemyId,
      });
    }
  }
  // 快照决定战败回滚到哪个世界：它本身必须是可恢复的独立实体 store。
  const snapshot = battle.preBattleSnapshot;
  if (snapshot !== undefined) {
    const [structureIssue] = validateEntityStoreStructure(snapshot.entityStore);
    const [referenceIssue] = structureIssue === undefined ? validateEntityReferences(snapshot.entityStore) : [];
    if (structureIssue !== undefined || referenceIssue !== undefined) {
      issues.push({
        code: "invalid_battle_snapshot",
        entityId: battleEntityId,
        ...(referenceIssue?.referencedId === undefined ? {} : { referencedId: referenceIssue.referencedId }),
      });
    }
  }
  return issues;
}

function endingRequirementReference(
  requirement: EndingRequirement,
  known: { readonly quests: ReadonlySet<string>; readonly facts: ReadonlySet<string>; readonly npcs: ReadonlySet<string> },
): { readonly referencedId: string; readonly resolved: boolean } {
  switch (requirement.kind) {
    case "quest_completed":
    case "quest_failed":
      return { referencedId: requirement.questId, resolved: known.quests.has(requirement.questId) };
    case "fact_discovered":
      return { referencedId: requirement.factId, resolved: known.facts.has(requirement.factId) };
    case "npc_affinity_at_least":
    case "npc_affinity_at_most":
      return { referencedId: requirement.npcId, resolved: known.npcs.has(requirement.npcId) };
  }
}

export function validateWorldStateEntityReferences(
  worldState: WorldState,
): readonly WorldStateEntityReferenceIssue[] {
  const store = worldState.entityStore;
  const known = {
    quests: new Set(entitiesOfKind(store, "quest").map((record) => record.core.id)),
    facts: new Set(entitiesOfKind(store, "fact").map((record) => record.core.id)),
    npcs: new Set(entitiesOfKind(store, "npc").map((record) => record.core.id)),
  };
  const enemies = new Set(entitiesOfKind(store, "enemy").map((record) => record.core.id));
  const issues = [...battleIssues(worldState, enemies)];

  for (const entry of worldState.endings) {
    for (const requirement of entry.requirements) {
      const reference = endingRequirementReference(requirement, known);
      if (!reference.resolved) {
        issues.push({
          code: "unknown_ending_requirement_ref",
          entityId: entry.id,
          referencedId: reference.referencedId,
        });
      }
    }
  }

  const resolved = worldState.ending;
  if (resolved !== null && !worldState.endings.some((entry) => entry.id === resolved.endingId)) {
    issues.push({ code: "unknown_resolved_ending_ref", entityId: resolved.endingId, referencedId: resolved.endingId });
  }
  return issues;
}
