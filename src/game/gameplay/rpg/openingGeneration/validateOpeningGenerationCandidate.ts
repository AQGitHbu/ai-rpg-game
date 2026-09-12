import type { GameLength } from "@/game/domain/newGame";
import { TARGET_ACTS } from "@/game/domain/storyBudget";
import type { OpeningGenerationCandidate } from "@/game/domain/openingGenerationCandidate";
import { parseNpcCreationAnchors, parseNpcGoalProposals } from "@/game/domain/entity";
import { investigationApproachListIsValid } from "@/game/gameplay/rpg/worldEvolution";
import { resolveOpeningResponses } from "./openingSituationRules";

// ---------------------------------------------------------------------------
// Task 2：开局切片候选的 gameplay 校验（无 schema 校验——那由 domain parser
// 负责）。这里只做跨字段引用完整性、契约档位一致性与封闭约束：
//   - storyContract.targetActs 必须等于 context.targetActs（TARGET_ACTS[gameLength] 是权威）；
//   - publicFacts key 全局唯一；
//   - NPC known/private fact keys 必须是 publicFacts key 的子集（缺失 key = 校验错误）；
//   - 带 investigationApproaches 的 publicFact 必须通过完整安全校验（数量 2-3、
//     条目字段合法、无完整正文泄漏），否则记录 invalid_investigation_approaches
//     并拒绝候选——开局有确定性 fallback，未获批数据绝不能进入编译。
// ---------------------------------------------------------------------------

export type OpeningGenerationIssueCode =
  | "contract_target_acts_mismatch"
  | "duplicate_fact_key"
  | "unknown_fact_key"
  | "invalid_investigation_approaches"
  | "invalid_npc_anchors"
  | "invalid_npc_goals"
  | "invalid_delivery_contract"
  | "invalid_opening_item"
  | "invalid_opening_situation";

export type OpeningGenerationIssue = {
  readonly code: OpeningGenerationIssueCode;
  readonly params?: { readonly expected?: number; readonly actual?: number; readonly key?: string };
};

export type ValidateOpeningGenerationResult =
  | { readonly ok: true; readonly validated: OpeningGenerationCandidate }
  | { readonly ok: false; readonly issues: readonly OpeningGenerationIssue[] };

export type OpeningGenerationValidationContext = {
  readonly gameLength: GameLength;
  readonly targetActs: number;
};

function validOpeningAnchors(value: unknown): boolean {
  return parseNpcCreationAnchors(value) !== null;
}

function validOpeningGoals(value: unknown): boolean {
  return parseNpcGoalProposals(value) !== null;
}

function validLocalStoryKey(value: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(value)
    && !/^(?:loc|npc|item|quest|enemy|fact|ending)_\d+$/.test(value);
}

export function validateOpeningGenerationCandidate(
  candidate: OpeningGenerationCandidate,
  context: OpeningGenerationValidationContext,
): ValidateOpeningGenerationResult {
  const issues: OpeningGenerationIssue[] = [];

  const expectedActs = TARGET_ACTS[context.gameLength];
  if (context.targetActs !== expectedActs) {
    issues.push({ code: "contract_target_acts_mismatch", params: { expected: expectedActs, actual: context.targetActs } });
  }
  if (candidate.storyContract.targetActs !== context.targetActs) {
    issues.push({ code: "contract_target_acts_mismatch", params: { expected: context.targetActs, actual: candidate.storyContract.targetActs } });
  }

  if (!validOpeningAnchors(candidate.opening.npc.anchors)) {
    issues.push({ code: "invalid_npc_anchors" });
  }
  if (!validOpeningGoals(candidate.opening.npc.goals)) {
    issues.push({ code: "invalid_npc_goals" });
  }

  if (candidate.opening.item !== undefined) {
    const item = candidate.opening.item;
    if ([item.key, item.name, item.description, item.kind].some((value) => value.trim() === "")
      || !validLocalStoryKey(item.key)
      || item.tags.some((tag) => tag.trim() === "")
      || new Set(item.tags).size !== item.tags.length) {
      issues.push({ code: "invalid_opening_item", params: { key: item.key } });
    }
  }

  const factKeys = new Set<string>();
  for (const fact of candidate.world.publicFacts) {
    if (factKeys.has(fact.key)) {
      issues.push({ code: "duplicate_fact_key", params: { key: fact.key } });
    }
    factKeys.add(fact.key);
  }

  if (resolveOpeningResponses(candidate) === null) {
    issues.push({ code: "invalid_opening_situation" });
  }

  for (const key of [...candidate.opening.npc.knownFactKeys, ...candidate.opening.npc.privateFactKeys]) {
    if (!factKeys.has(key)) {
      issues.push({ code: "unknown_fact_key", params: { key } });
    }
  }

  const delivery = candidate.storyContract.delivery;
  if (delivery !== undefined) {
    if (candidate.opening.item === undefined || candidate.opening.item.key !== delivery.itemKey
      || !validLocalStoryKey(delivery.itemKey)
      || !validLocalStoryKey(delivery.recipientKey)
      || delivery.verificationFactKeys.length === 0
      || new Set(delivery.verificationFactKeys).size !== delivery.verificationFactKeys.length
      || delivery.verificationFactKeys.some((key) => !validLocalStoryKey(key) || !factKeys.has(key))) {
      issues.push({ code: "invalid_delivery_contract", params: { key: delivery.itemKey } });
    }
  }

  for (const fact of candidate.world.publicFacts) {
    if (fact.investigationApproaches === undefined) continue;
    // 严格 fail-fast：任意一条非法（含完整正文泄漏、重复 id、越界张力）都拒绝
    // 候选——compile 对 investigationApproaches 是逐字拷贝，部分合法条目
    // 无法被“过滤后放行”，否则泄漏条目仍会随原样字段进入 WorldFactEntry。
    if (!investigationApproachListIsValid(fact.investigationApproaches, fact.text)) {
      issues.push({ code: "invalid_investigation_approaches", params: { key: fact.key } });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, validated: candidate };
}
