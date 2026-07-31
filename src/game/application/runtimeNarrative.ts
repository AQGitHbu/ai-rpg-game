// ---------------------------------------------------------------------------
// Phase 10 Task 3：运行时导演 / 编剧 / 演员的纯 application port。
// 本文件只有类型与冻结常量：不读文件、不读 process.env、不 import server 代码。
// 三角色 source 实现在 Task 6；本层只声明最小 source 契约。
// ---------------------------------------------------------------------------

import type { ApprovedDirectorPlan, ApprovedSceneScript, NpcPerformanceProposal } from "@/game/gameplay/rpg/narrative";

// ---------------------------------------------------------------------------
// 契约版本
// ---------------------------------------------------------------------------

export const NARRATIVE_CONTRACT_VERSION = "runtime-narrative-v2" as const;
export type NarrativeContractVersion = typeof NARRATIVE_CONTRACT_VERSION;

// ---------------------------------------------------------------------------
// 失败类别
// ---------------------------------------------------------------------------

export const NARRATIVE_FAILURE_CATEGORIES = Object.freeze([
  "invalid_json",
  "schema_violation",
  "reference_broken",
  "rejected_by_rules",
  "timeout",
  "rate_limited",
  "service_error",
  "empty_response",
  "semantic_drift",
  "knowledge_scope_violation",
] as const);

export type NarrativeFailureCategory =
  (typeof NARRATIVE_FAILURE_CATEGORIES)[number];

// ---------------------------------------------------------------------------
// 公共结构
// ---------------------------------------------------------------------------

export type NarrativeDiagnostics = Readonly<{
  traceId: string;
  contractVersion: NarrativeContractVersion;
  stage: "requested" | "candidate_received" | "validating" | "approved" | "completed" | "failed";
  category?: NarrativeFailureCategory;
}>;

// ---------------------------------------------------------------------------
// 导演角色
// ---------------------------------------------------------------------------

export type DirectorRequest = Readonly<{
  traceId: string;
  context: Record<string, unknown>;
}>;

export type DirectorAttempt =
  | Readonly<{
      ok: true;
      provenance: "generated" | "fixture";
      plan: ApprovedDirectorPlan;
      diagnostics: NarrativeDiagnostics;
    }>
  | Readonly<{
      ok: false;
      provenance: "generated" | "fixture" | "unavailable";
      category: NarrativeFailureCategory;
      diagnostics: NarrativeDiagnostics;
    }>;

export type DirectorSource = {
  generate(request: DirectorRequest): Promise<DirectorAttempt>;
};

// ---------------------------------------------------------------------------
// 编剧角色
// ---------------------------------------------------------------------------

export type SceneScriptRequest = Readonly<{
  traceId: string;
  context: Record<string, unknown>;
}>;

export type SceneScriptAttempt =
  | Readonly<{
      ok: true;
      provenance: "generated" | "fixture";
      script: ApprovedSceneScript;
      diagnostics: NarrativeDiagnostics;
    }>
  | Readonly<{
      ok: false;
      provenance: "generated" | "fixture" | "unavailable";
      category: NarrativeFailureCategory;
      diagnostics: NarrativeDiagnostics;
    }>;

export type SceneScriptSource = {
  generate(request: SceneScriptRequest): Promise<SceneScriptAttempt>;
};

// ---------------------------------------------------------------------------
// 演员角色
// ---------------------------------------------------------------------------

export type NpcLineRequest = Readonly<{
  traceId: string;
  context: Record<string, unknown>;
}>;

export type NpcLineAttempt =
  | Readonly<{
      ok: true;
      provenance: "generated" | "fixture";
      performance: NpcPerformanceProposal;
      diagnostics: NarrativeDiagnostics;
    }>
  | Readonly<{
      ok: false;
      provenance: "generated" | "fixture" | "unavailable";
      category: NarrativeFailureCategory;
      diagnostics: NarrativeDiagnostics;
    }>;

export type NpcLineSource = {
  generate(request: NpcLineRequest): Promise<NpcLineAttempt>;
};
