// ---------------------------------------------------------------------------
// storyEvalCapture：评估专用采集通道（spec §6）。
//
// 只有两个职责：
// 1. StoryEvalSink —— 同步追加写 JSONL 的容错 sink（写失败静默降级，绝不抛错）；
// 2. createStoryEvalApprovalObserver —— 把编排层审批事件映射为 sink 记录。
// prompt/模型原文只在 source 内部捕获后写入；审批结果只在编排层可见后写入；
// 本模块不 import repository/persistence/transport（目录边界守卫保证）。
// 未装配（captureSink/approvalObserver 为 undefined）时零开销、零行为变化。
// ---------------------------------------------------------------------------

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
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

/** 同步追加写 calls.jsonl；目录/写入失败一律静默降级（与日志 sink 同一容错哲学）。 */
export function createFileStoryEvalSink(directory: string): StoryEvalSink {
  let filePath: string | null = null;
  try {
    mkdirSync(directory, { recursive: true });
    filePath = join(directory, "calls.jsonl");
  } catch {
    // 目录创建失败：降级为 no-op sink，绝不抛错到游戏主流程。
  }
  return {
    append(record) {
      if (filePath === null) return;
      try {
        appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
      } catch {
        // 写失败静默降级。
      }
    },
  };
}

/** 把编排层审批事件映射为 sink 记录；由 composition root 注入编排层。 */
export function createStoryEvalApprovalObserver(
  sink: StoryEvalSink
): (event: StoryEvalApprovalEvent) => void {
  return (event) => {
    try {
      if (event.kind === "role_approval") {
        sink.append({
          kind: "role_approval",
          traceId: event.traceId,
          role: event.role,
          attempt: event.attempt,
          category: event.category,
        });
      } else if (event.kind === "plan_approved") {
        sink.append({
          kind: "plan_approved",
          traceId: event.traceId,
          attempt: event.attempt,
          planSummary: event.planSummary,
        });
      } else {
        sink.append({ kind: "expansion_decision", traceId: event.traceId, decision: event.decision });
      }
    } catch {
      // 采集失败绝不抛到游戏主流程。
    }
  };
}
