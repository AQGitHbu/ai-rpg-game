import type { WorldState, LocationEntry, NpcEntry, ItemEntry, EnemyEntry, WorldFactEntry } from "@/game/domain/worldState";
import type { StoryBudget } from "@/game/domain/storyBudget";
import { budgetAllowsExpansion, withinHardLimit, consumeExpansion } from "@/game/domain/storyBudget";
import {
  asLocationId, asNpcId, asItemId, asEnemyId, asFactId,
} from "@/game/domain/scenarioBlueprint";
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

  const newLocations: LocationEntry[] = [];
  const newNpcs: NpcEntry[] = [];
  const newItems: ItemEntry[] = [];
  const newEnemies: EnemyEntry[] = [];
  const newFacts: WorldFactEntry[] = [];
  const rejected: { proposal: ExpansionProposal; reason: ExpansionRejection }[] = [];

  let workingBudget = budget;

  for (const proposal of proposals) {
    const result = approveOne(proposal, ws, workingBudget, existingLocationIds, existingNpcIds, existingItemIds, existingEnemyIds, existingFactIds, deps, idOverride);
    if (result.ok) {
      switch (proposal.kind) {
        case "location": {
          const locEntry = result.entry as LocationEntry;
          newLocations.push(locEntry);
          existingLocationIds.add(String(locEntry.id));
          workingBudget = consumeExpansion(workingBudget, "locations");
          break;
        }
        case "npc": {
          const npcEntry = result.entry as NpcEntry;
          newNpcs.push(npcEntry);
          existingNpcIds.add(String(npcEntry.id));
          workingBudget = consumeExpansion(workingBudget, "npcs");
          break;
        }
        case "item": {
          const itemEntry = result.entry as ItemEntry;
          newItems.push(itemEntry);
          existingItemIds.add(String(itemEntry.id));
          break;
        }
        case "enemy": {
          const enemyEntry = result.entry as EnemyEntry;
          newEnemies.push(enemyEntry);
          existingEnemyIds.add(String(enemyEntry.id));
          break;
        }
        case "fact": {
          const factEntry = result.entry as WorldFactEntry;
          newFacts.push(factEntry);
          existingFactIds.add(String(factEntry.factId));
          workingBudget = consumeExpansion(workingBudget, "events");
          break;
        }
      }
    } else {
      rejected.push({ proposal, reason: result.reason });
    }
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
      const id = idOverride?.kind === "location" ? asLocationId(idOverride.id) : asLocationId(deps.genId("loc_exp"));
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
      const id = idOverride?.kind === "npc" ? asNpcId(idOverride.id) : asNpcId(deps.genId("npc_exp"));
      const entry: NpcEntry = {
        id,
        name: proposal.name,
        role: proposal.role,
        description: proposal.description,
        locationId: asLocationId(proposal.locationId),
        isCompanion: false,
        tags: [],
        met: false,
        memory: {
          npcId: id,
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
      if (codePointLength(proposal.name) < 2 || codePointLength(proposal.name) > 40) return { ok: false, reason: "invalid_payload" };
      if (codePointLength(proposal.description) < 5 || codePointLength(proposal.description) > 240) return { ok: false, reason: "invalid_payload" };
      if (!existingLocationIds.has(proposal.locationId)) return { ok: false, reason: "reference_broken" };
      const id = asItemId(deps.genId("item_exp"));
      const entry: ItemEntry = {
        id,
        name: proposal.name,
        description: proposal.description,
        kind: proposal.kind_hint,
        tags: [...proposal.tags],
      };
      return { ok: true, entry };
    }
    case "enemy": {
      if (codePointLength(proposal.name) < 2 || codePointLength(proposal.name) > 40) return { ok: false, reason: "invalid_payload" };
      if (proposal.stats.hp < 1 || proposal.stats.hp > 999) return { ok: false, reason: "invalid_payload" };
      if (proposal.stats.attack < 0 || proposal.stats.attack > 99) return { ok: false, reason: "invalid_payload" };
      if (proposal.stats.defense < 0 || proposal.stats.defense > 99) return { ok: false, reason: "invalid_payload" };
      if (!existingLocationIds.has(proposal.locationId)) return { ok: false, reason: "reference_broken" };
      const id = asEnemyId(deps.genId("enemy_exp"));
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
      if (codePointLength(proposal.text) < 5 || codePointLength(proposal.text) > 240) return { ok: false, reason: "invalid_payload" };
      if (!existingLocationIds.has(proposal.locationId)) return { ok: false, reason: "reference_broken" };
      const id = asFactId(deps.genId("fact_exp"));
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
