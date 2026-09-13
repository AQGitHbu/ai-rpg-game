import type { AiMessage } from "@ai-game/ai-transport";
import { parseStructuredJsonObject } from "@/game/core/json";
import type { GameLogger } from "@/game/logging";
import { candidateReviewMatches, type CandidateDefect, type CandidateDefectCode, type CandidateReviewResult, type CandidateReviewScope, type NarrativeCandidateReviewer } from "../../narrativeCandidateReview";
import { buildNarrativeReviewRules, parseRuleEvidence, canonicalCandidatePath } from "./narrativeReviewRules";
import type { CandidateQualityObservation } from "../../narrativeCandidateReview";
import type { NarrativeCandidateReviewInput } from "../../narrativeCandidateReview";
import type { RpgAiClient } from "./rpgAiClient";
import type { NarrativeRequestClient } from "./narrativeRequestClient";
import { compileDecisionNarrativeContext } from "./narrativeContext";
import { OPENING_SEMANTIC_CONTRACT } from "./openingSemanticContract";
import { buildOpeningNarrativePrompt } from "./openingNarrativePrompt";

export type LiveNarrativeCandidateReviewDeps = Readonly<{
  readonly aiClient?: RpgAiClient;
  readonly requestClient?: NarrativeRequestClient;
  readonly logger?: GameLogger;
}>;

const SCOPES: readonly CandidateReviewScope[] = ["scene", "proposal", "npc_behavior"];
const CODES: readonly CandidateDefectCode[] = [
  "MISSED_INPUT", "UNSUPPORTED_FACT", "DISCLOSURE", "ACTION_MISMATCH", "BROKEN_CAUSALITY",
];

// The review contract is intentionally narrower than the language model's
// natural vocabulary. Keep a small, observed compatibility map at this
// boundary so a semantically useful revise verdict is repairable instead of
// becoming an opaque UNCERTAIN failure. Unknown aliases still fail closed.
const CODE_ALIASES: Readonly<Record<string, CandidateDefectCode>> = {
  MISSED_INPUT: "MISSED_INPUT",
  UNSUPPORTED_FACT: "UNSUPPORTED_FACT",
  DISCLOSURE: "DISCLOSURE",
  ACTION_MISMATCH: "ACTION_MISMATCH",
  BROKEN_CAUSALITY: "BROKEN_CAUSALITY",
  unaddressed_input: "MISSED_INPUT",
  unsupported_knowledge: "UNSUPPORTED_FACT",
  unwarranted_knowledge: "UNSUPPORTED_FACT",
  undefined_fact_reference: "UNSUPPORTED_FACT",
  invalid_fact_reference: "UNSUPPORTED_FACT",
  private_fact_publicized: "DISCLOSURE",
  private_fact_marked_public: "DISCLOSURE",
  secret_as_public: "DISCLOSURE",
  audience_disclosure: "DISCLOSURE",
  choice_action_mismatch: "ACTION_MISMATCH",
  verification_fact_mismatch: "BROKEN_CAUSALITY",
  beat_contradiction: "BROKEN_CAUSALITY",
};

const SCOPE_ALIASES: Readonly<Record<string, CandidateReviewScope>> = {
  scene: "scene",
  proposal: "proposal",
  npc_behavior: "npc_behavior",
  currentScene: "scene",
  currentScene_npcLine: "scene",
  currentScene_choices: "scene",
  opening_currentScene: "scene",
  opening_currentScene_choices: "scene",
  world: "proposal",
  opening_world: "proposal",
  opening_world_publicFacts: "proposal",
  delivery_contract: "proposal",
  opening_npc: "npc_behavior",
  npc: "npc_behavior",
  npc_knowledge: "npc_behavior",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseDefects(
  value: unknown,
  input: NarrativeCandidateReviewInput,
): readonly CandidateDefect[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const defects: CandidateDefect[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !hasOnlyKeys(entry, ["scope", "code", "path", "reason", "evidence"])) {
      return null;
    }
    const scope = typeof entry.scope === "string" ? SCOPE_ALIASES[entry.scope] : undefined;
    const code = typeof entry.code === "string" ? CODE_ALIASES[entry.code] : undefined;
    if (scope === undefined
      || code === undefined
      || !SCOPES.includes(scope)
      || !CODES.includes(code)
      || !isNonEmptyString(entry.path)
      || !isNonEmptyString(entry.reason)) {
      return null;
    }
    const evidence = parseRuleEvidence(entry.evidence, buildNarrativeReviewRules(input));
    const path = canonicalCandidatePath(input.proposal, entry.path);
    if (evidence === null || path === null) return null;
    defects.push({
      evidence,
      candidateVersion: input.candidateVersion,
      candidateHash: input.candidateHash,
      scope,
      code,
      path,
      reason: entry.reason,
    });
  }
  return defects;
}

function parseQualityObservations(value: unknown): readonly CandidateQualityObservation[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) return null;
  const observations: CandidateQualityObservation[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !hasOnlyKeys(entry, ["path", "reason"])
      || !isNonEmptyString(entry.path) || !isNonEmptyString(entry.reason)) return null;
    observations.push({ path: entry.path, reason: entry.reason });
  }
  return observations;
}

function parseReviewVerdict(
  value: unknown,
  input: NarrativeCandidateReviewInput,
): ({ readonly pass: true } | { readonly pass: false; readonly defects: readonly CandidateDefect[] })
  & { readonly qualityObservations: readonly CandidateQualityObservation[] } | null {
  if (!isRecord(value)) return null;
  const review = isRecord(value.review) && hasOnlyKeys(value, ["review"]) ? value.review : value;
  const qualityObservations = parseQualityObservations(review.qualityObservations);
  if (qualityObservations === null) return null;
  if (review.verdict === "pass" && hasOnlyKeys(review, ["verdict", "qualityObservations"])) return { pass: true, qualityObservations };
  if ((review.verdict === "revise" && hasOnlyKeys(review, ["verdict", "defects", "qualityObservations"]))
    || hasOnlyKeys(review, ["defects", "qualityObservations"])) {
    const defects = parseDefects(review.defects, input);
    // Never filter unsupported defects and turn the remaining response into pass.
    return defects === null ? null : { pass: false, defects, qualityObservations };
  }
  return null;
}

function reviewJobMetadata(input: NarrativeCandidateReviewInput): { readonly jobId?: string; readonly gameId?: string; readonly actionId?: string; readonly turnNumber?: number } {
  if (input.context.kind === "opening") {
    return {
      jobId: String(input.context.jobId),
      ...(input.context.auditLink?.gameId === undefined ? {} : { gameId: input.context.auditLink.gameId }),
    };
  }
  return {
    jobId: String(input.context.job.jobId),
    ...(input.context.auditLink?.gameId === undefined ? {} : { gameId: input.context.auditLink.gameId }),
    actionId: input.context.job.actionId,
    turnNumber: input.context.job.turnNumber,
  };
}

function resultFailure(input: NarrativeCandidateReviewInput, failure: "PROVIDER_FAILURE" | "UNCERTAIN"): CandidateReviewResult {
  return {
    ok: false,
    candidateVersion: input.candidateVersion,
    candidateHash: input.candidateHash,
    failure,
  };
}

function publicReviewContext(input: NarrativeCandidateReviewInput): unknown {
  if (input.context.kind === "opening") {
    const { signal: _signal, reserveHttpAttempt: _reserveHttpAttempt, ...openingInput } = input.context.input;
    const openingProposal = "opening" in input.proposal ? input.proposal.opening : undefined;
    return {
      kind: "opening",
      ruleBasis: buildNarrativeReviewRules(input),
      jobId: input.context.jobId,
      candidateVersion: input.context.candidateVersion,
      input: openingInput,
      contract: OPENING_SEMANTIC_CONTRACT,
      authorPrompt: buildOpeningNarrativePrompt(input.context),
      factBindings: openingProposal !== undefined ? openingProposal.world.publicFacts.map((fact, index) => ({
        key: fact.key,
        factId: `fact_${index}`,
        disclosure: openingProposal.opening.npc.privateFactKeys.includes(fact.key) ? "secret" : "public",
      })) : [],
    };
  }
  const compilation = compileDecisionNarrativeContext({
    consumer: "reviewer",
    worldState: input.context.worldState,
    storyState: input.context.storyState,
    job: input.context.job,
    ...(input.context.npcOutward === undefined ? {} : { npcOutward: input.context.npcOutward }),
  });
  return {
    kind: "decision",
    ruleBasis: buildNarrativeReviewRules(input),
    candidateVersion: input.context.candidateVersion,
    prompt: compilation.prompt,
    manifest: compilation.manifest,
  };
}

export function createLiveNarrativeCandidateReview(
  deps: LiveNarrativeCandidateReviewDeps = {},
): NarrativeCandidateReviewer {
  return {
    async reviewNarrativeCandidate(input): Promise<CandidateReviewResult> {
      if (deps.aiClient === undefined) return resultFailure(input, "PROVIDER_FAILURE");
      try {
        const metadata = reviewJobMetadata(input);
        const messages: readonly AiMessage[] = [
          {
            role: "system",
            content: [
              "你是 RPG 整场候选的逻辑语义审阅器。",
              "只检查当前输入是否被回应、事实依据、实际受众披露、选项动作与正文因果。",
              "阻断缺陷必须引用 context.ruleBasis 中真实存在的 key，并选择该依据列出的 impact，再具体解释哪项规则后果被改写。evidence={basisKey,impact,detail}，path 必须定位候选中真实存在的字段，使用候选内路径（如 currentScene.npcLine.text）；也接受请求包装的单层 proposal. 或 $.proposal. 前缀，返回缺陷时服务端统一去掉该前缀。数组必须使用真实数字索引 [0]，不得用其他包装别名、多层 proposal 或猜测字段。",
              "无玩法效果的服饰、环境、动作姿态和风格属于 qualityObservations=[{path,reason}]，不影响 verdict；物品持有/交付违规必须引用具体正式 item 的依据，不能因为普通装饰没有 Entity ID 就判背包违规。真实交付、知识披露、Action 绑定与续接顺序仍须严格检查。",
              "fact 目录区分 ID 存在、获准提案引用与当前允许披露正文；authorizedProposalKeys 许可结构化提案引用，不表示玩家已知或现在可说出正文。未在公开事实正文中列出不能推断 ID 不存在。不要根据秘密 ID 猜测内容。",
              "不得改写候选、补造事实、授予知识或输出思维链。",
              "只返回 JSON：通过为 {\"verdict\":\"pass\"}，需修订为 {\"verdict\":\"revise\",\"defects\":[{\"scope\",\"code\",\"path\",\"reason\",\"evidence\":{\"basisKey\",\"impact\",\"detail\"}}]}。",
              "scope 只能是 scene、proposal、npc_behavior；code 只能是 MISSED_INPUT、UNSUPPORTED_FACT、DISCLOSURE、ACTION_MISMATCH、BROKEN_CAUSALITY。",
              "不要创造其他 scope 或 code；无法归类时仍使用上述最接近的稳定 code，并把具体说明写入 reason。",
            ].join("\n"),
          },
          {
            role: "user",
            content: JSON.stringify({
              candidateVersion: input.candidateVersion,
              candidateHash: input.candidateHash,
              context: publicReviewContext(input),
              proposal: input.proposal,
            }),
          },
        ];
        const auditContext = {
          purpose: "narrative_candidate_review",
          trigger: "narrative_candidate_review",
          revision: input.candidateVersion,
          ...metadata,
        } as const;
        const result = deps.requestClient === undefined
          ? await deps.aiClient.complete("narrative_bundle", messages, auditContext)
          : await deps.requestClient.completeNarrativeRequest({
              purpose: "review",
              messages,
              auditContext,
              signal: input.context.signal ?? new AbortController().signal,
              ...(input.context.reserveHttpAttempt === undefined ? {} : { reserveHttpAttempt: input.context.reserveHttpAttempt }),
            });
        if (!result.ok) return resultFailure(input, "PROVIDER_FAILURE");
        const parsed = parseStructuredJsonObject(result.content);
        if (!parsed.ok) return resultFailure(input, "UNCERTAIN");
        const verdict = parseReviewVerdict(parsed.value, input);
        if (verdict === null) return resultFailure(input, "UNCERTAIN");
        if (verdict.pass) {
          return { ok: true, candidateVersion: input.candidateVersion, candidateHash: input.candidateHash,
            ...(verdict.qualityObservations.length === 0 ? {} : { qualityObservations: verdict.qualityObservations }) };
        }
        return {
          ok: false,
          candidateVersion: input.candidateVersion,
          candidateHash: input.candidateHash,
          defects: verdict.defects,
          ...(verdict.qualityObservations.length === 0 ? {} : { qualityObservations: verdict.qualityObservations }),
        };
      } catch (error) {
        deps.logger?.warn("narrative_candidate_review_failed", {
          error: error instanceof Error ? error.message : "unknown",
        });
        return resultFailure(input, "PROVIDER_FAILURE");
      }
    },
  };
}

export { candidateReviewMatches };
