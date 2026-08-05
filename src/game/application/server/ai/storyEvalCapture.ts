// ---------------------------------------------------------------------------
// storyEvalCapture：评估专用采集通道实现（spec §6）。
//
// 只有两个职责：
// 1. createFileStoryEvalSink —— 同步追加写 JSONL 的容错 sink（写失败静默降级，绝不抛错）；
// 2. createStoryEvalApprovalObserver —— 把编排层审批事件映射为 sink 记录。
// 类型契约（StoryEvalCallRecord / StoryEvalApprovalRecord / StoryEvalRecord /
// StoryEvalSink / StoryEvalApprovalEvent）在 application 层
// ../../storyEvalCaptureTypes.ts（零 node:fs），本模块只保留 node:fs 实现。
// prompt/模型原文只在 source 内部捕获后写入；审批结果只在编排层可见后写入；
// 本模块不 import repository/persistence/transport（目录边界守卫保证）。
// 未装配（captureSink/approvalObserver 为 undefined）时零开销、零行为变化。
// ---------------------------------------------------------------------------

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { StoryEvalApprovalEvent, StoryEvalSink } from "../../storyEvalCaptureTypes";

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
