import type { GameLength } from "@/game/domain/newGame";
import { TARGET_ACTS } from "@/game/domain/storyBudget";
import type { OpeningGenerationCandidate } from "@/game/domain/openingGenerationCandidate";

// ---------------------------------------------------------------------------
// Task 2：开局切片候选的 gameplay 校验（无 schema 校验——那由 domain parser
// 负责）。这里只做跨字段引用完整性、契约档位一致性与封闭约束：
//   - storyContract.targetActs 必须等于 context.targetActs（TARGET_ACTS[gameLength] 是权威）；
//   - publicFacts key 全局唯一；
//   - NPC known/private fact keys 必须是 publicFacts key 的子集（缺失 key = 校验错误）。
// ---------------------------------------------------------------------------

export type OpeningGenerationIssueCode =
  | "contract_target_acts_mismatch"
  | "duplicate_fact_key"
  | "unknown_fact_key";

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

  const factKeys = new Set<string>();
  for (const fact of candidate.world.publicFacts) {
    if (factKeys.has(fact.key)) {
      issues.push({ code: "duplicate_fact_key", params: { key: fact.key } });
    }
    factKeys.add(fact.key);
  }

  for (const key of [...candidate.opening.npc.knownFactKeys, ...candidate.opening.npc.privateFactKeys]) {
    if (!factKeys.has(key)) {
      issues.push({ code: "unknown_fact_key", params: { key } });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, validated: candidate };
}
