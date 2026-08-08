"use client";

import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import type { NarrativeGenerationProgress } from "@/game/application";

const NARRATIVE_GENERATION_MESSAGE =
  "正在调用 AI 生成下一段剧情，请稍候…";

/**
 * 场景生成期间的阻塞提示。
 *
 * 这个组件只覆盖当前界面，不接收 onClose：pending 结束前不能由玩家手动解除，
 * 由父级在 API 轮询得到非 pending view 后卸载。
 *
 * 进度来源有两种：
 * - `progress`（V1 三角色流水线）：按角色阶段上报，展示"已完成 X / Y 个阶段"。
 * - `totalApiCalls`（V2 严格流水线）：本次场景生成的真实 AI 调用次数，展示"将调用 N 次"。
 * 二者互斥，最多传一个；都不传时仅显示通用等待文案。
 */
const ROLE_LABELS: Record<NarrativeGenerationProgress["currentRole"], string> = {
  director: "导演",
  writer: "编剧",
  npc: "演员",
};

type NarrativeGenerationModalProps = {
  readonly progress?: NarrativeGenerationProgress;
  /** V2 场景生成为单次原子 AI 调用：本次将调用的真实 AI 请求数。 */
  readonly totalApiCalls?: number;
  readonly unavailable?: boolean;
};

export function NarrativeGenerationModal({
  progress,
  totalApiCalls,
  unavailable = false,
}: NarrativeGenerationModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  function stopUnderlyingOverlayShortcuts(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === "Escape") {
      event.stopPropagation();
    }
  }

  return (
    <section
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="narrative-generation-modal"
      tabIndex={-1}
      onKeyDown={stopUnderlyingOverlayShortcuts}
    >
      <div className="narrative-generation-modal-backdrop" aria-hidden="true" />
      <div className="narrative-generation-modal-content">
        <h2 id={titleId}>{unavailable ? "场景准备暂时中断" : "正在准备场景"}</h2>
        <p role="status" aria-live="polite">
          {unavailable
            ? "场景生成服务暂时不可用，请刷新页面重试。"
            : NARRATIVE_GENERATION_MESSAGE}
        </p>
        {!unavailable ? (
          <p role="status" aria-live="polite">
            {progress !== undefined
              ? `已完成 ${progress.completedCalls} / ${progress.totalCalls} 个阶段，当前${ROLE_LABELS[progress.currentRole]}第${progress.attempt}次尝试`
              : totalApiCalls !== undefined
                ? `本次生成将调用 ${totalApiCalls} 次 AI`
                : "（正在启动）"}
          </p>
        ) : null}
      </div>
    </section>
  );
}
