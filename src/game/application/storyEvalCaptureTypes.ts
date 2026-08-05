// ---------------------------------------------------------------------------
// storyEvalCaptureTypes：评估采集类型契约（spec §6）。
//
// application 层类型模块：只承载采集记录/事件/sink 的类型定义（唯一外部依赖
// BlueprintExpansionDecision，来自 gameplay narrative 门面），零 node:fs、
// 零 server 依赖。函数实现（createFileStoryEvalSink / createStoryEvalApprovalObserver）
// 留在 server/ai/storyEvalCapture.ts；本模块类型是 analyze/judge 脚本与采集通道
// 间的契约来源（traceId/attempt 关联键语义以本模块 doc 注释为准）。
// ---------------------------------------------------------------------------

import type { BlueprintExpansionDecision } from "@/game/gameplay/rpg/narrative";

/** source 工厂捕获回调写入的记录：一次 AI 调用的完整素材（仅采集模式）。
 *  关联键契约：traceId 为场景级原始 id（source 层从 request.traceId 去角色/重试后缀归一化），
 *  attempt 为同场景同角色 1-based 尝试序号；按 traceId + role + attempt 与审批记录关联。 */
export type StoryEvalCallRecord = {
  readonly kind: "ai_call";
  readonly role: "scenario" | "director" | "writer" | "npc";
  readonly traceId: string;
  readonly attempt: number;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly rawResponse: string | null;
  readonly parsedCandidate: Readonly<Record<string, unknown>> | null;
  readonly failureCategory: string | null;
  readonly latencyMs: number;
};

/** 编排层审批记录：按 traceId + role + attempt 与 ai_call 记录关联（同一关联键契约）。
 *  traceId 为场景级原始 id；attempt 为同场景同角色 1-based 尝试序号。 */
export type StoryEvalApprovalRecord =
  | {
      readonly kind: "role_approval";
      readonly traceId: string;
      readonly role: "director" | "writer" | "npc";
      readonly attempt: number;
      readonly category: string | null;
    }
  | {
      readonly kind: "plan_approved";
      readonly traceId: string;
      readonly attempt: number;
      readonly planSummary: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "expansion_decision";
      readonly traceId: string;
      readonly decision: BlueprintExpansionDecision;
    };

export type StoryEvalRecord = StoryEvalCallRecord | StoryEvalApprovalRecord;

export type StoryEvalSink = Readonly<{
  append(record: StoryEvalRecord): void;
}>;

/** 编排层审批事件（orchestrateNarrativeScene 内部产生，经 approvalObserver 发出）。 */
export type StoryEvalApprovalEvent =
  | {
      readonly kind: "role_approval";
      readonly traceId: string;
      readonly role: "director" | "writer" | "npc";
      readonly attempt: number;
      readonly category: string | null;
    }
  | {
      readonly kind: "plan_approved";
      readonly traceId: string;
      readonly attempt: number;
      readonly planSummary: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "expansion_decision";
      readonly traceId: string;
      readonly decision: BlueprintExpansionDecision;
    };
