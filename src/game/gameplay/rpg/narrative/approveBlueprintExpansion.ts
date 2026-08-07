import {
  budgetPolicyOf,
  finalMainActOf,
  locationScaleOf,
  type GameState,
  type ScenarioBlueprint
} from "@/game/domain";
import type {
  ApprovedBlueprintExpansion,
  ApprovedDirectorPlan,
  BlueprintExpansionDecision,
  ProposedNewLocation,
  ProposedNewNpc,
  ProposedNewFact,
  ProposedNewItem,
  ProposedNewEnemy
} from "./types";

// ---------------------------------------------------------------------------
// approveBlueprintExpansion：纯语义闸门（spec §4.5）。
// 扩展审批失败绝不使整个场景失败——场景照常生成，扩展被丢弃并返回稳定拒绝码。
// 闸门顺序固定：none_proposed → invalid_payload → pacing_locked → endgame_locked
//   → soft_cap_reached → hard_cap_reached → connect_not_unlocked → town_cap_reached。
// ---------------------------------------------------------------------------

export type ApproveBlueprintExpansionInput = {
  readonly blueprint: ScenarioBlueprint;
  readonly state: GameState;
  readonly plan: ApprovedDirectorPlan;
};

const codePointLength = (value: string) => Array.from(value).length;

export function approveBlueprintExpansion(
  input: ApproveBlueprintExpansionInput
): BlueprintExpansionDecision {
  const { blueprint, state, plan } = input;
  const policy = budgetPolicyOf(blueprint);

  const proposedLocation = plan.proposedNewLocations[0] ?? null;
  const proposedNpc = plan.proposedNewNpcs[0] ?? null;
  const proposedFact = plan.proposedNewFacts?.[0] ?? null;
  const proposedItem = plan.proposedNewItems?.[0] ?? null;
  const proposedEnemy = plan.proposedNewEnemies?.[0] ?? null;
  const resourceCount = [proposedFact, proposedItem, proposedEnemy].filter((entry) => entry !== null).length;

  // 1. none_proposed
  if (proposedLocation === null && proposedNpc === null && resourceCount === 0) {
    return { ok: false, reason: "none_proposed" };
  }

  // 2. invalid_payload
  if (proposedLocation !== null && !isValidLocationPayload(proposedLocation, blueprint)) {
    return { ok: false, reason: "invalid_payload" };
  }
  if (proposedNpc !== null && !isValidNpcPayload(proposedNpc, blueprint, proposedLocation !== null)) {
    return { ok: false, reason: "invalid_payload" };
  }
  if (resourceCount > 1 || !isValidResourcePayload({ proposedFact, proposedItem, proposedEnemy }, plan.eventKind, blueprint, state)) {
    return { ok: false, reason: "invalid_payload" };
  }

  // 3. pacing_locked
  if (plan.pacing === "climax" || plan.pacing === "resolution") {
    return { ok: false, reason: "pacing_locked" };
  }

  // 4. endgame_locked
  if (isEndgame(blueprint, state)) {
    return { ok: false, reason: "endgame_locked" };
  }

  // 5. soft_cap_reached
  if (proposedLocation !== null && policy.expansion.locationsSoftMax !== null) {
    if (blueprint.locations.length >= policy.expansion.locationsSoftMax) {
      return { ok: false, reason: "soft_cap_reached" };
    }
  }
  if (proposedNpc !== null && policy.expansion.npcsSoftMax !== null) {
    if (blueprint.npcs.length >= policy.expansion.npcsSoftMax) {
      return { ok: false, reason: "soft_cap_reached" };
    }
  }

  // 6. hard_cap_reached
  if (proposedLocation !== null && blueprint.locations.length >= policy.safety.locationsHardMax) {
    return { ok: false, reason: "hard_cap_reached" };
  }
  if (proposedNpc !== null && blueprint.npcs.length >= policy.safety.npcsHardMax) {
    return { ok: false, reason: "hard_cap_reached" };
  }

  // 7. connect_not_unlocked
  if (proposedLocation !== null) {
    const unlockedIds = new Set(state.unlockedLocationIds.map(String));
    if (!unlockedIds.has(proposedLocation.connectFromLocationId)) {
      return { ok: false, reason: "connect_not_unlocked" };
    }
  }

  // 8. town_cap_reached
  if (proposedLocation !== null && proposedLocation.scale === "town") {
    const townCount = blueprint.locations.filter(
      (loc) => locationScaleOf(loc) === "town"
    ).length;
    if (townCount >= policy.opening.townLocationsMax) {
      return { ok: false, reason: "town_cap_reached" };
    }
  }

  // Approved: field-by-field rebuild (never return AI object by reference)
  const expansion: ApprovedBlueprintExpansion = {
    newLocation: proposedLocation !== null ? { ...proposedLocation } : null,
    newNpc: proposedNpc !== null ? { ...proposedNpc } : null,
    newFact: proposedFact !== null ? { ...proposedFact } : null,
    newItem: proposedItem !== null ? { ...proposedItem, tags: [...proposedItem.tags] } : null,
    newEnemy: proposedEnemy !== null ? { ...proposedEnemy, stats: { ...proposedEnemy.stats } } : null,
  };

  return { ok: true, expansion };
}

function isValidLocationPayload(
  loc: ProposedNewLocation,
  blueprint: ScenarioBlueprint
): boolean {
  if (codePointLength(loc.name) < 2 || codePointLength(loc.name) > 20) return false;
  if (codePointLength(loc.description) < 10 || codePointLength(loc.description) > 120) return false;
  if (codePointLength(loc.reason) < 10 || codePointLength(loc.reason) > 100) return false;
  if (loc.scale !== "scene" && loc.scale !== "town") return false;
  const allLocationIds = new Set(blueprint.locations.map((l) => String(l.id)));
  if (!allLocationIds.has(loc.connectFromLocationId)) return false;
  return true;
}

function isValidNpcPayload(
  npc: ProposedNewNpc,
  blueprint: ScenarioBlueprint,
  hasNewLocation: boolean
): boolean {
  if (codePointLength(npc.name) < 2 || codePointLength(npc.name) > 20) return false;
  if (codePointLength(npc.role) < 2 || codePointLength(npc.role) > 40) return false;
  if (codePointLength(npc.description) < 10 || codePointLength(npc.description) > 120) return false;
  if (npc.locationId === "new:0") {
    if (!hasNewLocation) return false;
  } else {
    const allLocationIds = new Set(blueprint.locations.map((l) => String(l.id)));
    if (!allLocationIds.has(npc.locationId)) return false;
  }
  return true;
}

function isValidResourcePayload(
  resources: { readonly proposedFact: ProposedNewFact | null; readonly proposedItem: ProposedNewItem | null; readonly proposedEnemy: ProposedNewEnemy | null },
  eventKind: ApprovedDirectorPlan["eventKind"],
  blueprint: ScenarioBlueprint,
  state: GameState,
): boolean {
  const { proposedFact, proposedItem, proposedEnemy } = resources;
  if (proposedFact === null && proposedItem === null && proposedEnemy === null) return true;
  const currentLocationId = String(state.currentLocationId);
  if (eventKind === "investigate" && proposedFact !== null) {
    return codePointLength(proposedFact.text) >= 5 && codePointLength(proposedFact.text) <= 240 &&
      codePointLength(proposedFact.reason) >= 5 && codePointLength(proposedFact.reason) <= 120 &&
      proposedFact.locationId === currentLocationId;
  }
  if (eventKind === "item" && proposedItem !== null) {
    return codePointLength(proposedItem.name) >= 2 && codePointLength(proposedItem.name) <= 40 &&
      codePointLength(proposedItem.description) >= 5 && codePointLength(proposedItem.description) <= 240 &&
      codePointLength(proposedItem.kind) >= 1 && codePointLength(proposedItem.kind) <= 40 &&
      proposedItem.locationId === currentLocationId && proposedItem.tags.length <= 8;
  }
  if (eventKind === "battle" && proposedEnemy !== null) {
    return codePointLength(proposedEnemy.name) >= 2 && codePointLength(proposedEnemy.name) <= 40 &&
      codePointLength(proposedEnemy.reason) >= 5 && codePointLength(proposedEnemy.reason) <= 120 &&
      proposedEnemy.locationId === currentLocationId &&
      proposedEnemy.stats.hp >= 1 && proposedEnemy.stats.hp <= 999 &&
      proposedEnemy.stats.attack >= 0 && proposedEnemy.stats.attack <= 99 &&
      proposedEnemy.stats.defense >= 0 && proposedEnemy.stats.defense <= 99 &&
      (proposedEnemy.tier === "normal" || proposedEnemy.tier === "boss");
  }
  // A resource must be authorized by the event it belongs to. The existing
  // blueprint and state references are otherwise intentionally not enough.
  void blueprint;
  return false;
}

function isEndgame(blueprint: ScenarioBlueprint, state: GameState): boolean {
  const finalAct = finalMainActOf(blueprint);
  const mainQuestDefs = blueprint.quests.filter((q) => q.kind === "main");
  const mainQuestIds = new Set(mainQuestDefs.map((q) => String(q.id)));
  const mainRuntime = state.quests.filter((q) => mainQuestIds.has(String(q.questId)));
  const allCompleted = mainRuntime.length > 0 && mainRuntime.every((q) => q.status === "completed");
  if (allCompleted) return true;
  const activeMain = mainRuntime.find((q) => q.status === "active");
  if (activeMain !== undefined) {
    const def = mainQuestDefs.find((q) => String(q.id) === String(activeMain.questId));
    if (def !== undefined && def.stage === finalAct) return true;
  }
  return false;
}
