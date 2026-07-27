"use client";

import { useState } from "react";
import { Panel, Tag, InlineButton } from "@ai-game/ui";
import type { GameSessionView, SessionActionView } from "@/game/application";
import { postGameAction, type GameActionPayload } from "./gameActionRequest";

// ---------------------------------------------------------------------------
// SceneActionPanel（Phase 3 Task 5 + Phase 4 Task 4）：固定行动面板。
// 消费 GameSessionView.availableActions 中的非 move 行动（move 归
// TravelPanel），禁用提交中的所有按钮，以 aria-live 提示结果。
// 成功后用 API 返回的最新 view 替换本地 view；规则拒绝显示具体但不
// 伪造成功；版本冲突后触发重新请求 current-game。外部 busy（其他
// 面板提交中）同样禁用，避免并发写入。
// 不显示未发现事实、任务/战斗按钮，也不提供自由文本输入框。
// ---------------------------------------------------------------------------

type SceneActionView = Exclude<SessionActionView, { type: "move" | "take_item" }>;

type SceneActionPanelProps = {
  view: GameSessionView;
  /** 其他面板提交中：为 true 时禁用本面板全部按钮。 */
  busy?: boolean;
  /** 本面板提交开始/结束回调：父级据此禁用其余面板。 */
  onBusyChange?: (busy: boolean) => void;
  onActionSuccess: (view: GameSessionView) => void;
  onStaleRevision: () => void;
};

type FeedbackState =
  | { readonly phase: "idle" }
  | { readonly phase: "submitting" }
  | { readonly phase: "success"; readonly message: string }
  | { readonly phase: "rejected"; readonly message: string }
  | { readonly phase: "error"; readonly message: string };

function buildIntentPayload(action: SceneActionView, revision: number): GameActionPayload {
  switch (action.type) {
    case "observe":
      return { intent: { type: "observe", locationId: action.locationId }, revision };
    case "talk":
      return { intent: { type: "talk", npcId: action.npcId }, revision };
    case "investigate":
      return { intent: { type: "investigate", factId: action.factId }, revision };
  }
}

export function SceneActionPanel({
  view,
  busy = false,
  onBusyChange,
  onActionSuccess,
  onStaleRevision
}: SceneActionPanelProps) {
  const [feedback, setFeedback] = useState<FeedbackState>({ phase: "idle" });

  const isSubmitting = feedback.phase === "submitting";
  const disabled = busy || isSubmitting;

  // move 行动由 TravelPanel 渲染、take_item 由 Phase 5 Task 4 接入 UI：
  // 这里只保留观察/交谈/调查。
  const sceneActions = view.availableActions.filter(
    (action): action is SceneActionView =>
      action.type !== "move" && action.type !== "take_item"
  );

  async function handleAction(action: SceneActionView) {
    setFeedback({ phase: "submitting" });
    onBusyChange?.(true);

    const outcome = await postGameAction(buildIntentPayload(action, view.revision));

    onBusyChange?.(false);
    switch (outcome.kind) {
      case "success":
        setFeedback({ phase: "success", message: outcome.message });
        onActionSuccess(outcome.view);
        return;
      case "rejected":
        // 拒绝不改状态：只显示反馈，不更新 view。
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
      eyebrow="行动面板"
      header={(
        <div className="panel-heading">
          <h2>你可以执行的行动</h2>
          <Tag variant="info">Revision {view.revision}</Tag>
        </div>
      )}
    >
      {sceneActions.length === 0 ? (
        <p className="action-hint">当前没有可执行的新行动。</p>
      ) : (
        <div className="action-buttons" role="group" aria-label="可用行动">
          {sceneActions.map((action, index) => (
            <InlineButton
              key={`${action.type}-${index}`}
              onClick={() => void handleAction(action)}
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
          正在处理行动……
        </p>
      )}
    </Panel>
  );
}
