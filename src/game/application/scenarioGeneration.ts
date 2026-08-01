import type { ValidatedNewGameInput } from "@/game/domain";
import type { ScenarioBlueprintCandidate } from "@/game/domain";

// ---------------------------------------------------------------------------
// Phase 4A/4B：AI 候选生成的纯 application port（spec §3，契约 scenario-dynamic-v2）。
// 本文件只有类型与冻结常量：不读文件、不读 process.env、不 import server 代码。
// server-only fixture source 与 live source 都实现 ScenarioCandidateSource；
// 候选永远不能绕过既有 validateScenarioBlueprintCandidate/compileScenarioBlueprint。
// ---------------------------------------------------------------------------

/** 当前候选契约版本；蓝图动态化升至 scenario-dynamic-v2（budgetPolicy 取代 contentBudget）。 */
export const SCENARIO_CANDIDATE_CONTRACT_VERSION = "scenario-dynamic-v2" as const;
export type ScenarioCandidateContractVersion = typeof SCENARIO_CANDIDATE_CONTRACT_VERSION;

/** 创建结果暴露给 API/UI 的唯一安全来源区分（spec §5）。 */
export type ScenarioGenerationSource = "generated" | "fallback";

/**
 * 稳定失败类别初始集合（spec §3 枚举顺序）。
 * 冻结数组是契约测试的断言目标；派生 union 供 attempt/manifest 使用。
 */
export const SCENARIO_CANDIDATE_FAILURE_CATEGORIES = Object.freeze([
  "invalid_json",
  "schema_violation",
  "budget_exceeded",
  "reference_broken",
  "unreachable_ending",
  "cross_type_content",
  "illegal_entity",
  "timeout",
  "rate_limited",
  "service_error",
  "empty_response"
] as const);

export type ScenarioCandidateFailureCategory =
  (typeof SCENARIO_CANDIDATE_FAILURE_CATEGORIES)[number];

/**
 * 生成阶段（spec §3）：completed / failed 是 4A 仅有的两个终态。
 * 阶段记录只供 contract test、结构化日志与受控开发诊断，不随玩家 API 返回。
 */
export type ScenarioGenerationStage =
  | "requested"
  | "candidate_received"
  | "validating"
  | "repairing"
  | "retrying"
  | "falling_back"
  | "completed"
  | "failed";

/** 编排层向 observer 投递的阶段事件；failed 额外允许 persistence_failure。 */
export type ScenarioGenerationEvent = Readonly<{
  stage: ScenarioGenerationStage;
  traceId?: string;
  outcome?: ScenarioGenerationSource;
  category?: ScenarioCandidateFailureCategory | "persistence_failure";
}>;

export type ScenarioGenerationRequest = Readonly<{
  input: ValidatedNewGameInput;
  seed: string;
  traceId: string;
}>;

/**
 * source 的单次尝试结果。diagnostics 只含稳定代码：
 * 不含 prompt、完整玩家输入、原始响应或任何密钥。
 */
export type ScenarioCandidateAttempt =
  | Readonly<{
      ok: true;
      contractVersion: ScenarioCandidateContractVersion;
      origin: "fixture" | "live";
      candidate: ScenarioBlueprintCandidate;
      diagnostics: readonly string[];
    }>
  | Readonly<{
      ok: false;
      contractVersion: ScenarioCandidateContractVersion;
      origin: "fixture" | "live" | "unavailable";
      category: ScenarioCandidateFailureCategory;
      diagnostics: readonly string[];
    }>;

/** AI 候选来源门面：无 repository、无状态写权限（spec §3）。 */
export type ScenarioCandidateSource = Readonly<{
  generate(request: ScenarioGenerationRequest): Promise<ScenarioCandidateAttempt>;
}>;
