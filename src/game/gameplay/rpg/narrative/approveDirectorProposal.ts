import type { GameState, ScenarioBlueprint } from "@/game/domain";
import type { NarrativeActionCandidate } from "./types";
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

  // suggestedActionKeys must be exactly two different keys from candidates
  const [keyA, keyB] = proposal.suggestedActionKeys;
  if (keyA === keyB) {
    return { ok: false, category: "choice_not_legal" };
  }
  const candidateKeys = new Set(candidates.map((c) => c.actionKey));
  if (!candidateKeys.has(keyA) || !candidateKeys.has(keyB)) {
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

  // Construct approved object field by field (never return AI object by reference)
  const approved: ApprovedDirectorPlan = {
    sceneGoal: proposal.sceneGoal,
    tensionLevel: proposal.tensionLevel,
    focusNpcId: proposal.focusNpcId,
    relevantFactIds: [...proposal.relevantFactIds],
    allowedRevealFactIds: [...proposal.allowedRevealFactIds],
    suggestedActionKeys: [...proposal.suggestedActionKeys] as readonly [string, string],
    introducedEntities: proposal.introducedEntities.map((e) => ({ ...e })),
    pacing: proposal.pacing,
  };

  return { ok: true, value: approved };
}
