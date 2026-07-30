// ---------------------------------------------------------------------------
// Town 层：AI 小镇规划生成的纯 application port（契约 town-plan-v1）。
// 本文件只有类型与冻结常量：不读文件、不读 process.env、不 import server 代码。
// source 只产出未经信任的候选（unknown）；候选永远不能绕过 gameplay 的
// validateTownPlanCandidate（含 generateTown 编译验证）。AI 永不接触坐标。
// ---------------------------------------------------------------------------

/** 当前小镇规划候选契约版本。 */
export const TOWN_PLAN_CONTRACT_VERSION = "town-plan-v1" as const;
export type TownPlanContractVersion = typeof TOWN_PLAN_CONTRACT_VERSION;

/**
 * 稳定失败类别集合：schema_violation / coverage_missing / compile_failed
 * 与 validateTownPlanCandidate 的拒绝原因一一对应，其余为 provider 侧失败。
 * 冻结数组是契约测试的断言目标；派生 union 供 attempt 使用。
 */
export const TOWN_PLAN_FAILURE_CATEGORIES = Object.freeze([
  "invalid_json",
  "schema_violation",
  "coverage_missing",
  "compile_failed",
  "timeout",
  "rate_limited",
  "service_error",
  "empty_response"
] as const);

export type TownPlanFailureCategory = (typeof TOWN_PLAN_FAILURE_CATEGORIES)[number];

/**
 * 小镇规划生成请求：只携带地点/NPC/世界基调的封闭语义上下文与确定性 seed。
 * 不含坐标、不含完整蓝图、不含玩家自由文本之外的任何敏感信息。
 */
export type TownPlanRequest = Readonly<{
  locationId: string;
  locationName: string;
  locationDescription: string;
  locationTags: readonly string[];
  /** 该地点的剧情 NPC：AI 必须为每个 NPC 规划一座建筑（key = story_npc_<id>）。 */
  npcs: readonly Readonly<{ id: string; name: string; role: string }>[];
  worldTone: string;
  worldThemes: readonly string[];
  seed: string;
  traceId: string;
}>;

/**
 * source 的单次尝试结果。candidate 为未经信任的原始 JSON 值，必须交由
 * gameplay 的 validateTownPlanCandidate 校验+编译验证后才能入档。
 * diagnostics 只含稳定代码：不含 prompt、原始响应或任何密钥。
 */
export type TownPlanAttempt =
  | Readonly<{
      ok: true;
      contractVersion: TownPlanContractVersion;
      origin: "fixture" | "live";
      candidate: unknown;
      diagnostics: readonly string[];
    }>
  | Readonly<{
      ok: false;
      contractVersion: TownPlanContractVersion;
      origin: "fixture" | "live" | "unavailable";
      category: TownPlanFailureCategory;
      diagnostics: readonly string[];
    }>;

/** AI 小镇规划来源门面：无 repository、无状态写权限。 */
export type TownPlanCandidateSource = Readonly<{
  generate(request: TownPlanRequest): Promise<TownPlanAttempt>;
}>;
