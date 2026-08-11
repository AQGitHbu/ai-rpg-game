import type { WorldState, LocationEntry, NpcEntry, ItemEntry, EnemyEntry, WorldFactEntry } from "@/game/domain/worldState";
import type { StoryBudget } from "@/game/domain/storyBudget";
import { budgetAllowsExpansion, withinHardLimit, consumeExpansion } from "@/game/domain/storyBudget";
import {
  asLocationId, asNpcId, asItemId, asEnemyId, asFactId,
} from "@/game/domain/worldEntity";
import type { ExpansionProposal, ApprovedExpansion, ExpansionRejection } from "./expansionTypes";

const codePointLength = (value: string) => Array.from(value).length;

export type ApprovalResult = {
  readonly approved: ApprovedExpansion;
  readonly rejected: readonly { readonly proposal: ExpansionProposal; readonly reason: ExpansionRejection }[];
  readonly nextBudget: StoryBudget;
};

export type ApproveDeps = {
  readonly genId: (prefix: string) => string;
};

export function approveExpansions(
  proposals: readonly ExpansionProposal[],
  ws: WorldState,
  budget: StoryBudget,
  deps: ApproveDeps,
  idOverride?: { readonly kind: "location" | "npc"; readonly id: string },
): ApprovalResult {
  const existingLocationIds = new Set(ws.locations.map((l) => String(l.id)));
  const existingNpcIds = new Set(ws.npcs.map((n) => String(n.id)));
  const existingItemIds = new Set(ws.items.map((i) => String(i.id)));
  const existingEnemyIds = new Set(ws.enemies.map((e) => String(e.id)));
  const existingFactIds = new Set(ws.worldFacts.map((f) => String(f.factId)));

  // 同批已生成的 ID：保证同一批次内多种实体 ID 全局唯一（Spec §15.3-5）
  const generatedIds = new Set<string>();

  const newLocations: LocationEntry[] = [];
  const newNpcs: NpcEntry[] = [];
  const newItems: ItemEntry[] = [];
  const newEnemies: EnemyEntry[] = [];
  const newFacts: WorldFactEntry[] = [];
  const rejected: { proposal: ExpansionProposal; reason: ExpansionRejection }[] = [];

  let workingBudget = budget;

  // 第一遍：逐条审批（按提案顺序），新实体 ID 进入同批 ID 集合
  for (const proposal of proposals) {
    const result = approveOne(
      proposal,
      ws,
      workingBudget,
      existingLocationIds,
      existingNpcIds,
      existingItemIds,
      existingEnemyIds,
      existingFactIds,
      generatedIds,
      deps,
      idOverride,
    );
    if (result.ok) {
      switch (proposal.kind) {
        case "location": {
          const locEntry = result.entry as LocationEntry;
          newLocations.push(locEntry);
          existingLocationIds.add(String(locEntry.id));
          generatedIds.add(String(locEntry.id));
          workingBudget = consumeExpansion(workingBudget, "locations");
          break;
        }
        case "npc": {
          const npcEntry = result.entry as NpcEntry;
          newNpcs.push(npcEntry);
          existingNpcIds.add(String(npcEntry.id));
          generatedIds.add(String(npcEntry.id));
          workingBudget = consumeExpansion(workingBudget, "npcs");
          break;
        }
        case "item": {
          const itemEntry = result.entry as ItemEntry;
          newItems.push(itemEntry);
          existingItemIds.add(String(itemEntry.id));
          generatedIds.add(String(itemEntry.id));
          workingBudget = consumeExpansion(workingBudget, "events");
          break;
        }
        case "enemy": {
          const enemyEntry = result.entry as EnemyEntry;
          newEnemies.push(enemyEntry);
          existingEnemyIds.add(String(enemyEntry.id));
          generatedIds.add(String(enemyEntry.id));
          workingBudget = consumeExpansion(workingBudget, "events");
          break;
        }
        case "fact": {
          const factEntry = result.entry as WorldFactEntry;
          newFacts.push(factEntry);
          existingFactIds.add(String(factEntry.factId));
          generatedIds.add(String(factEntry.factId));
          workingBudget = consumeExpansion(workingBudget, "events");
          break;
        }
      }
    } else {
      rejected.push({ proposal, reason: result.reason });
    }
  }

  // 第二遍：整批合并后引用再验证（跨批引用——新实体指向同批另一新实体）
  const batchRefsOk = validateBatchReferences(
    newLocations,
    newNpcs,
    newItems,
    newEnemies,
    newFacts,
    existingLocationIds,
    existingNpcIds,
    existingItemIds,
    existingEnemyIds,
    existingFactIds,
  );
  if (!batchRefsOk) {
    // 引用断裂：整批拒绝（不拆分提交不完整实体）
    return {
      approved: {
        newLocations: [],
        newNpcs: [],
        newItems: [],
        newEnemies: [],
        newFacts: [],
        budgetConsumed: { locations: 0, npcs: 0, items: 0, enemies: 0, facts: 0 },
      },
      rejected: proposals.map((p) => ({ proposal: p, reason: "reference_broken" as const })),
      nextBudget: budget,
    };
  }

  return {
    approved: {
      newLocations,
      newNpcs,
      newItems,
      newEnemies,
      newFacts,
      budgetConsumed: {
        locations: newLocations.length,
        npcs: newNpcs.length,
        items: newItems.length,
        enemies: newEnemies.length,
        facts: newFacts.length,
      },
    },
    rejected,
    nextBudget: workingBudget,
  };
}

/** 同批合并后的引用完整性：所有新实体引用必须指向已存在或同批新建的实体。 */
function validateBatchReferences(
  newLocations: readonly LocationEntry[],
  newNpcs: readonly NpcEntry[],
  newItems: readonly ItemEntry[],
  newEnemies: readonly EnemyEntry[],
  newFacts: readonly WorldFactEntry[],
  existingLocationIds: Set<string>,
  existingNpcIds: Set<string>,
  existingItemIds: Set<string>,
  existingEnemyIds: Set<string>,
  _existingFactIds: Set<string>,
): boolean {
  const locIds = new Set(existingLocationIds);
  newLocations.forEach((l) => locIds.add(String(l.id)));
  const npcIds = new Set(existingNpcIds);
  newNpcs.forEach((n) => npcIds.add(String(n.id)));
  const itemIds = new Set(existingItemIds);
  newItems.forEach((i) => itemIds.add(String(i.id)));
  const enemyIds = new Set(existingEnemyIds);
  newEnemies.forEach((e) => enemyIds.add(String(e.id)));

  for (const loc of newLocations) {
    if (loc.connectedLocationIds.some((c) => !locIds.has(String(c)))) return false;
    if (loc.npcIds.some((n) => !npcIds.has(String(n)))) return false;
    if (loc.availableItemIds.some((it) => !itemIds.has(String(it)))) return false;
  }
  for (const npc of newNpcs) {
    if (!locIds.has(String(npc.locationId))) return false;
  }
  for (const enemy of newEnemies) {
    if (!locIds.has(String(enemy.locationId))) return false;
  }
  for (const fact of newFacts) {
    if (fact.locationId !== undefined && !locIds.has(String(fact.locationId))) return false;
  }
  return true;
}

type ApproveOneResult =
  | { readonly ok: true; readonly entry: LocationEntry | NpcEntry | ItemEntry | EnemyEntry | WorldFactEntry }
  | { readonly ok: false; readonly reason: ExpansionRejection };

function approveOne(
  proposal: ExpansionProposal,
  _ws: WorldState,
  budget: StoryBudget,
  existingLocationIds: Set<string>,
  _existingNpcIds: Set<string>,
  _existingItemIds: Set<string>,
  _existingEnemyIds: Set<string>,
  _existingFactIds: Set<string>,
  generatedIds: Set<string>,
  deps: ApproveDeps,
  idOverride?: { readonly kind: "location" | "npc"; readonly id: string },
): ApproveOneResult {
  switch (proposal.kind) {
    case "location": {
      if (!budgetAllowsExpansion(budget, "locations")) return { ok: false, reason: "budget_exceeded" };
      if (!withinHardLimit(budget, "locations")) return { ok: false, reason: "hard_limit_exceeded" };
      if (codePointLength(proposal.name) < 2 || codePointLength(proposal.name) > 20) return { ok: false, reason: "invalid_payload" };
      if (codePointLength(proposal.description) < 10 || codePointLength(proposal.description) > 120) return { ok: false, reason: "invalid_payload" };
      if (proposal.scale !== "scene" && proposal.scale !== "town") return { ok: false, reason: "invalid_payload" };
      if (!existingLocationIds.has(proposal.connectFromLocationId)) return { ok: false, reason: "reference_broken" };
      const baseId = idOverride?.kind === "location" ? idOverride.id : deps.genId("loc_exp");
      const id = asLocationId(uniqueGeneratedId(baseId, existingLocationIds, generatedIds));
      const entry: LocationEntry = {
        id,
        name: proposal.name,
        description: proposal.description,
        kind: "main",
        connectedLocationIds: [asLocationId(proposal.connectFromLocationId)],
        npcIds: [],
        availableItemIds: [],
        tags: [],
        scale: proposal.scale,
      };
      return { ok: true, entry };
    }
    case "npc": {
      if (!budgetAllowsExpansion(budget, "npcs")) return { ok: false, reason: "budget_exceeded" };
      if (!withinHardLimit(budget, "npcs")) return { ok: false, reason: "hard_limit_exceeded" };
      if (codePointLength(proposal.name) < 2 || codePointLength(proposal.name) > 20) return { ok: false, reason: "invalid_payload" };
      if (codePointLength(proposal.role) < 2 || codePointLength(proposal.role) > 40) return { ok: false, reason: "invalid_payload" };
      if (codePointLength(proposal.description) < 10 || codePointLength(proposal.description) > 120) return { ok: false, reason: "invalid_payload" };
      if (!existingLocationIds.has(proposal.locationId)) return { ok: false, reason: "reference_broken" };
      const baseNpcId = idOverride?.kind === "npc" ? idOverride.id : deps.genId("npc_exp");
      const npcId = asNpcId(uniqueGeneratedId(baseNpcId, _existingNpcIds, generatedIds));
      const entry: NpcEntry = {
        id: npcId,
        name: proposal.name,
        role: proposal.role,
        description: proposal.description,
        locationId: asLocationId(proposal.locationId),
        isCompanion: false,
        tags: [],
        met: false,
        memory: {
          npcId,
          knownFactIds: [],
          hiddenFactIds: [],
          interactionHistory: [],
          relationship: { affinity: 0 },
          emotion: "neutral",
          goals: [],
        },
      };
      return { ok: true, entry };
    }
    case "item": {
      if (!budgetAllowsExpansion(budget, "events")) return { ok: false, reason: "budget_exceeded" };
      if (codePointLength(proposal.name) < 2 || codePointLength(proposal.name) > 40) return { ok: false, reason: "invalid_payload" };
      if (codePointLength(proposal.description) < 5 || codePointLength(proposal.description) > 240) return { ok: false, reason: "invalid_payload" };
      if (!existingLocationIds.has(proposal.locationId)) return { ok: false, reason: "reference_broken" };
      const baseItemId = deps.genId("item_exp");
      const id = asItemId(uniqueGeneratedId(baseItemId, new Set(), generatedIds));
      const entry: ItemEntry = {
        id,
        name: proposal.name,
        description: proposal.description,
        kind: proposal.kind_hint,
        tags: [...proposal.tags, `location_id:${proposal.locationId}`],
      };
      return { ok: true, entry };
    }
    case "enemy": {
      if (!budgetAllowsExpansion(budget, "events")) return { ok: false, reason: "budget_exceeded" };
      if (codePointLength(proposal.name) < 2 || codePointLength(proposal.name) > 40) return { ok: false, reason: "invalid_payload" };
      if (proposal.stats.hp < 1 || proposal.stats.hp > 999) return { ok: false, reason: "invalid_payload" };
      if (proposal.stats.attack < 0 || proposal.stats.attack > 99) return { ok: false, reason: "invalid_payload" };
      if (proposal.stats.defense < 0 || proposal.stats.defense > 99) return { ok: false, reason: "invalid_payload" };
      if (!existingLocationIds.has(proposal.locationId)) return { ok: false, reason: "reference_broken" };
      const baseEnemyId = deps.genId("enemy_exp");
      const id = asEnemyId(uniqueGeneratedId(baseEnemyId, new Set(), generatedIds));
      const entry: EnemyEntry = {
        id,
        name: proposal.name,
        tier: proposal.tier,
        stats: { ...proposal.stats },
        locationId: asLocationId(proposal.locationId),
        tags: [],
      };
      return { ok: true, entry };
    }
    case "fact": {
      if (!budgetAllowsExpansion(budget, "events")) return { ok: false, reason: "budget_exceeded" };
      if (codePointLength(proposal.text) < 5 || codePointLength(proposal.text) > 240) return { ok: false, reason: "invalid_payload" };
      if (!existingLocationIds.has(proposal.locationId)) return { ok: false, reason: "reference_broken" };
      const baseFactId = deps.genId("fact_exp");
      const id = asFactId(uniqueGeneratedId(baseFactId, new Set(), generatedIds));
      const entry: WorldFactEntry = {
        factId: id,
        text: proposal.text,
        source: "generated",
        discovered: false,
        locationId: asLocationId(proposal.locationId),
      };
      return { ok: true, entry };
    }
  }
}

/** 生成同批内唯一的 ID：若 base 已存在（既有实体或本批已生成），追加序号去重。 */
function uniqueGeneratedId(
  base: string,
  existingIds: Set<string>,
  generatedIds: Set<string>,
): string {
  if (!existingIds.has(base) && !generatedIds.has(base)) return base;
  let suffix = 1;
  while (existingIds.has(`${base}_${suffix}`) || generatedIds.has(`${base}_${suffix}`)) {
    suffix += 1;
  }
  return `${base}_${suffix}`;
}
