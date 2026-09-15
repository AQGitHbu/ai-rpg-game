import { getEntity, type NpcEntityRecord } from "@/game/domain/entity";
import type { StoryState } from "@/game/domain/storyState";
import type { StoryConsequenceBindingProposal, StoryConsequenceBindingsProposal, StoryConditionProposal } from "@/game/domain/storyConsequenceBindings";
import { isStoryConsequenceBindingsProposal } from "@/game/domain/storyConsequenceBindings";
import { parseNpcCooperationDefinition, type NpcCooperationDefinition, type StoryCondition } from "@/game/domain/storyInteraction";
import type { InvestigationApproach } from "@/game/domain/worldEntries";
import type { WorldState } from "@/game/domain/worldState";
import { applyEntityMutations, type EntityMutation } from "@/game/gameplay/rpg/entityWorld";
import { resolveStoryConditionProposal } from "./resolveStoryConditionProposal";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { validateInvestigationDependencies } from "@/game/gameplay/rpg/investigation";
import { isObjectiveSatisfied } from "@/game/gameplay/rpg/narrativeContext";

export type ApproveStoryConsequenceBindingsInput = Readonly<{
  proposal: StoryConsequenceBindingsProposal;
  worldState: WorldState;
  storyState: StoryState;
  symbols: ReadonlyMap<string, string>;
}>;

export type ApproveStoryConsequenceBindingsResult =
  | Readonly<{ ok: true; worldState: WorldState; storyState: StoryState }>
  | Readonly<{ ok: false; code: string; path: string }>;

function resolveId(raw: string, symbols: ReadonlyMap<string, string>): string | null {
  return symbols.get(raw) ?? (raw.trim() === "" ? null : raw);
}

function npcOf(worldState: WorldState, raw: string, symbols: ReadonlyMap<string, string>): NpcEntityRecord | null {
  const id = resolveId(raw, symbols);
  const record = id === null ? undefined : getEntity(worldState.entityStore, id);
  return record?.core.kind === "npc" && record.core.lifecycle === "active" ? record as NpcEntityRecord : null;
}

function conditionsOf(
  conditions: readonly StoryConditionProposal[],
  worldState: WorldState,
  symbols: ReadonlyMap<string, string>,
  path: string,
  allowEmpty = false,
): { ok: true; conditions: readonly StoryCondition[] } | { ok: false; code: string; path: string } {
  if ((!allowEmpty && conditions.length === 0) || conditions.length > 4) return { ok: false, code: "invalid_conditions", path };
  const resolved: StoryCondition[] = [];
  for (const [index, proposal] of conditions.entries()) {
    const result = resolveStoryConditionProposal({ proposal, worldState, symbols });
    if (!result.ok) return { ok: false, code: result.code, path: `${path}[${index}]` };
    resolved.push(result.condition);
  }
  return { ok: true, conditions: resolved };
}

function approachesOf(
  binding: Extract<StoryConsequenceBindingProposal, { kind: "bind_investigation" }>,
  worldState: WorldState,
  symbols: ReadonlyMap<string, string>,
  path: string,
): { ok: true; approaches: readonly InvestigationApproach[] } | { ok: false; code: string; path: string } {
  if (binding.approaches.length < 2 || binding.approaches.length > 3) return { ok: false, code: "invalid_investigation_definition", path };
  const ids = new Set<string>();
  const approaches: InvestigationApproach[] = [];
  for (const [index, approach] of binding.approaches.entries()) {
    if (approach.approachId.trim() === "" || ids.has(approach.approachId)) return { ok: false, code: "invalid_investigation_definition", path: `${path}[${index}]` };
    ids.add(approach.approachId);
    const conditions = approach.requirements === undefined
      ? { ok: true as const, conditions: [] as readonly StoryCondition[] }
      : conditionsOf(approach.requirements, worldState, symbols, `${path}[${index}].requirements`, true);
    if (!conditions.ok) return conditions;
    const witnesses: string[] = [];
    for (const rawWitness of approach.witnessNpcIds ?? []) {
      const witness = npcOf(worldState, rawWitness, symbols);
      if (witness === null || witnesses.includes(String(witness.core.id))) return { ok: false, code: "unknown_witness_ref", path: `${path}[${index}].witnessNpcIds` };
      witnesses.push(String(witness.core.id));
    }
    approaches.push({
      approachId: approach.approachId,
      label: approach.label,
      ...(approach.hint === undefined ? {} : { hint: approach.hint }),
      evidenceQuality: approach.evidenceQuality,
      tensionDelta: approach.tensionDelta,
      ...(conditions.conditions.length === 0 ? {} : { requirements: conditions.conditions }),
      ...(witnesses.length === 0 ? {} : { witnessNpcIds: witnesses as never }),
    });
  }
  return { ok: true, approaches };
}

function compileBinding(
  binding: StoryConsequenceBindingProposal,
  input: ApproveStoryConsequenceBindingsInput,
  index: number,
): { ok: true; mutation: EntityMutation } | { ok: false; code: string; path: string } {
  const { worldState, symbols } = input;
  const path = `bindings[${index}]`;
  switch (binding.kind) {
    case "bind_goal_resolution": {
      const npc = npcOf(worldState, binding.npcRef, symbols);
      if (npc === null || !Number.isInteger(binding.goalOrdinal) || binding.goalOrdinal < 0) return { ok: false, code: "unknown_goal_ref", path };
      const goal = npc.dynamicState.goals[binding.goalOrdinal];
      if (goal === undefined) return { ok: false, code: "unknown_goal_ref", path };
      const completeWhen = conditionsOf(binding.resolution.completeWhen, worldState, symbols, `${path}.resolution.completeWhen`, true);
      if (!completeWhen.ok) return completeWhen;
      const blockWhen = conditionsOf(binding.resolution.blockWhen, worldState, symbols, `${path}.resolution.blockWhen`, true);
      if (!blockWhen.ok) return blockWhen;
      return { ok: true, mutation: { kind: "bind_npc_goal_resolution", npcId: npc.core.id, goalId: goal.goalId, resolution: { completeWhen: completeWhen.conditions, blockWhen: blockWhen.conditions } } };
    }
    case "bind_investigation": {
      const factId = resolveId(binding.factRef, symbols);
      const fact = factId === null ? undefined : getEntity(worldState.entityStore, factId);
      if (fact?.core.kind !== "fact" || binding.discoveryMode !== "investigation") return { ok: false, code: "unknown_fact_ref", path };
      const approaches = approachesOf(binding, worldState, symbols, `${path}.approaches`);
      if (!approaches.ok) return approaches;
      return { ok: true, mutation: { kind: "bind_fact_investigation", factId: fact.core.id, approaches: approaches.approaches } };
    }
    case "bind_talk_completion": {
      const questId = resolveId(binding.questRef, symbols);
      const npc = npcOf(worldState, binding.npcRef, symbols);
      const quest = questId === null ? undefined : getEntity(worldState.entityStore, questId);
      if (npc === null || quest?.core.kind !== "quest") return { ok: false, code: "unknown_quest_or_npc_ref", path };
      const conditions = conditionsOf(binding.conditions, worldState, symbols, `${path}.conditions`);
      if (!conditions.ok) return conditions;
      return { ok: true, mutation: { kind: "bind_quest_talk_completion", questId: quest.core.id, npcId: npc.core.id, conditions: conditions.conditions } };
    }
    case "bind_npc_cooperation": {
      const npc = npcOf(worldState, binding.npcRef, symbols);
      if (npc === null || binding.definitions.length > 2) return { ok: false, code: "invalid_cooperation_definition", path };
      const operations = new Set<string>();
      const definitions: NpcCooperationDefinition[] = [];
      for (const [definitionIndex, definition] of binding.definitions.entries()) {
        if (operations.has(definition.operation)) return { ok: false, code: "invalid_cooperation_definition", path: `${path}.definitions[${definitionIndex}]` };
        operations.add(definition.operation);
        const requirements = conditionsOf(definition.requirements, worldState, symbols, `${path}.definitions[${definitionIndex}].requirements`);
        if (!requirements.ok) return requirements;
        if (!requirements.conditions.some((condition) => condition.kind === "goal_status" && String(condition.npcId) === String(npc.core.id))) {
          return { ok: false, code: "invalid_cooperation_definition", path: `${path}.definitions[${definitionIndex}]` };
        }
        const facts = definition.allowedFactIds.map((raw) => resolveId(raw, symbols));
        const audiences = definition.allowedAudienceIds.map((raw) => resolveId(raw, symbols));
        if (facts.some((id) => id === null || getEntity(worldState.entityStore, id)?.core.kind !== "fact")
          || audiences.some((id) => id === null || (id !== PLAYER_ENTITY_ID && getEntity(worldState.entityStore, id)?.core.kind !== "npc"))) {
          return { ok: false, code: "unknown_cooperation_ref", path: `${path}.definitions[${definitionIndex}]` };
        }
        const compiled: NpcCooperationDefinition = {
          operation: definition.operation,
          requirements: requirements.conditions,
          allowedFactIds: facts as string[] as never,
          allowedAudienceIds: audiences as string[] as never,
        };
        if (parseNpcCooperationDefinition(compiled) === null) {
          return { ok: false, code: "invalid_cooperation_definition", path: `${path}.definitions[${definitionIndex}]` };
        }
        definitions.push(compiled);
      }
      return { ok: true, mutation: { kind: "bind_npc_cooperation", npcId: npc.core.id, definitions } };
    }
  }
}

export function approveStoryConsequenceBindings(input: ApproveStoryConsequenceBindingsInput): ApproveStoryConsequenceBindingsResult {
  if (!isStoryConsequenceBindingsProposal(input.proposal)) return { ok: false, code: "invalid_bindings", path: "bindings" };
  if (input.proposal.length > 8) return { ok: false, code: "too_many_bindings", path: "bindings" };
  const mutations: EntityMutation[] = [];
  for (const [index, binding] of input.proposal.entries()) {
    const compiled = compileBinding(binding, input, index);
    if (!compiled.ok) return compiled;
    mutations.push(compiled.mutation);
  }
  const applied = applyEntityMutations(input.worldState, mutations);
  if (!applied.ok) return { ok: false, code: applied.code, path: "bindings" };
  // A new rule must govern a future action, not reinterpret the interaction
  // already settled by A. Otherwise B can advance an act after scene review.
  // Existing identical bindings remain idempotent even after being fulfilled.
  for (const [index, mutation] of mutations.entries()) {
    if (mutation.kind !== "bind_quest_talk_completion") continue;
    const previous = input.worldState.quests.find((quest) => quest.id === mutation.questId)?.objectives
      .find((objective) => objective.kind === "talk_to_npc" && objective.npcId === mutation.npcId);
    if (previous?.kind === "talk_to_npc" && previous.completionConditions !== undefined) continue;
    const objective = applied.worldState.quests.find((quest) => quest.id === mutation.questId)?.objectives
      .find((entry) => entry.kind === "talk_to_npc" && entry.npcId === mutation.npcId);
    if (objective !== undefined && isObjectiveSatisfied(applied.worldState, objective)) {
      return { ok: false, code: "retroactive_talk_completion", path: `bindings[${index}]` };
    }
  }
  if (mutations.length > 0) {
    const dependencies = validateInvestigationDependencies(applied.worldState);
    if (!dependencies.ok) return { ok: false, code: dependencies.code, path: `bindings:${dependencies.factId}` };
  }
  return { ok: true, worldState: applied.worldState, storyState: input.storyState };
}
