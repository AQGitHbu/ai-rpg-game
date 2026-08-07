"use client";

import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import type { NarrativeGenerationProgress } from "@/game/application";

const NARRATIVE_GENERATION_MESSAGE =
  "世界导演、编剧与当前角色正在依据已保存的规则结果准备场景。";

/**
 * 场景生成期间的阻塞提示。
 *
 * 这个组件只覆盖当前界面，不接收 onClose：pending 结束前不能由玩家手动解除，
 * 由父级在 API 轮询得到非 pending view 后卸载。
 */
const ROLE_LABELS: Record<NarrativeGenerationProgress["currentRole"], string> = {
  director: "导演",
  writer: "编剧",
  npc: "演员",
};

type NarrativeGenerationModalProps = {
  readonly progress?: NarrativeGenerationProgress;
  readonly unavailable?: boolean;
};

export function NarrativeGenerationModal({ progress, unavailable = false }: NarrativeGenerationModalProps) {
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
            已完成 {progress?.completedCalls ?? 0} / {progress?.totalCalls ?? 3} 个角色 API 阶段
            {progress === undefined ? "（正在启动）" : `，当前${ROLE_LABELS[progress.currentRole]}第${progress.attempt}次尝试`}
          </p>
        ) : null}
      </div>
    </section>
  );
}
