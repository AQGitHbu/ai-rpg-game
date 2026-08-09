"use client";

import { useState } from "react";
import { Panel, Tag, InlineButton } from "@ai-game/ui";
import type { CompatibilityGameSessionView, SessionActionView } from "@/game/application";
import { postGameAction } from "./gameActionRequest";

// ---------------------------------------------------------------------------
// TravelPanel（Phase 4 Task 4）：地点移动面板。
// 只渲染 CompatibilityGameSessionView.availableActions 中的 move 行动（连通且已解锁的
// 目的地由 read model 决定，UI 不自行猜测），提交/反馈模式与
// SceneActionPanel 一致：提交期间禁用全部按钮、aria-live 提示结果、
// 成功后用最新 view 替换、版本冲突触发重新读取当前存档。
// 外部 busy（另一面板提交中）同样禁用，避免并发写入。
// ---------------------------------------------------------------------------

type MoveActionView = Extract<SessionActionView, { type: "move" }>;

type TravelPanelProps = {
  view: CompatibilityGameSessionView;
  /** 其他面板提交中：为 true 时禁用本面板全部按钮。 */
  busy?: boolean;
  /** 本面板提交开始/结束回调：父级据此禁用其余面板。 */
  onBusyChange?: (busy: boolean) => void;
  onActionSuccess: (view: CompatibilityGameSessionView) => void;
  onStaleRevision: () => void;
};

type FeedbackState =
  | { readonly phase: "idle" }
  | { readonly phase: "submitting" }
  | { readonly phase: "success"; readonly message: string }
  | { readonly phase: "rejected"; readonly message: string }
  | { readonly phase: "error"; readonly message: string };

export function TravelPanel({
  view,
  busy = false,
  onBusyChange,
  onActionSuccess,
  onStaleRevision
}: TravelPanelProps) {
  const [feedback, setFeedback] = useState<FeedbackState>({ phase: "idle" });

  const isSubmitting = feedback.phase === "submitting";
  const disabled = busy || isSubmitting;

  const moveActions = view.availableActions.filter(
    (action): action is MoveActionView => action.type === "move"
  );

  async function handleMove(action: MoveActionView) {
    setFeedback({ phase: "submitting" });
    onBusyChange?.(true);

    const outcome = await postGameAction({
      intent: { type: "move", locationId: action.locationId },
      revision: view.revision
    });

    onBusyChange?.(false);
    switch (outcome.kind) {
      case "success":
        setFeedback({ phase: "success", message: outcome.message });
        onActionSuccess(outcome.view);
        return;
      case "rejected":
        setFeedback({ phase: "rejected", message: outcome.message });
        return;
      case "stale":
        setFeedback({ phase: "error", message: "状态已更新，请重试。" });
        onStaleRevision();
        return;
      case "error":
        setFeedback({ phase: "error", message: outcome.message });
    }
  }

  return (
    <Panel
      eyebrow="移动"
      header={(
        <div className="panel-heading">
          <h2>可前往的地点</h2>
          <Tag variant="info">当前：{view.currentLocation.name}</Tag>
        </div>
      )}
    >
      {moveActions.length === 0 ? (
        <p className="action-hint">当前没有可前往的相邻地点。</p>
      ) : (
        <div className="action-buttons" role="group" aria-label="可前往的地点">
          {moveActions.map((action) => (
            <InlineButton
              key={action.locationId}
              onClick={() => void handleMove(action)}
              disabled={disabled}
            >
              {action.label}
            </InlineButton>
          ))}
        </div>
      )}

      {feedback.phase !== "idle" && feedback.phase !== "submitting" && (
        <p
          role="status"
          aria-live="polite"
          className={
            feedback.phase === "success"
              ? "action-feedback success"
              : feedback.phase === "rejected"
                ? "action-feedback rejected"
                : "action-feedback error"
          }
        >
          {feedback.message}
        </p>
      )}

      {isSubmitting && (
        <p role="status" aria-live="polite" className="action-feedback submitting">
          正在赶路……
        </p>
      )}
    </Panel>
  );
}
