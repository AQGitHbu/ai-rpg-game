"use client";

import { useState } from "react";
import { Panel, Tag, InlineButton } from "@ai-game/ui";
import type { OpeningGameView, AvailableActionView } from "@/game/application";

// ---------------------------------------------------------------------------
// SceneActionPanel（Phase 3 Task 5）：固定行动面板。
// 只消费 OpeningGameView.availableActions，禁用提交中的所有按钮，以 aria-live
// 提示结果。成功后用 API 返回的最新 view 替换本地 view；规则拒绝显示具体但不
// 伪造成功；版本冲突后触发重新请求 current-game。
// 不显示未发现事实、不可用的未来移动/任务/战斗按钮，也不提供自由文本输入框。
// ---------------------------------------------------------------------------

type SceneActionPanelProps = {
  view: OpeningGameView;
  onActionSuccess: (view: OpeningGameView) => void;
  onStaleRevision: () => void;
};

type FeedbackState =
  | { readonly phase: "idle" }
  | { readonly phase: "submitting" }
  | { readonly phase: "success"; readonly message: string }
  | { readonly phase: "rejected"; readonly message: string }
  | { readonly phase: "error"; readonly message: string };

type ActionApiResponse = {
  readonly view?: OpeningGameView;
  readonly feedback?: { readonly ok: boolean; readonly message: string };
  readonly code?: string;
};

type ActionRequestPayload =
  | { readonly intent: { readonly type: "observe"; readonly locationId: string }; readonly revision: number }
  | { readonly intent: { readonly type: "talk"; readonly npcId: string }; readonly revision: number }
  | { readonly intent: { readonly type: "investigate"; readonly factId: string }; readonly revision: number };

function buildIntentPayload(action: AvailableActionView, revision: number): ActionRequestPayload {
  switch (action.type) {
    case "observe":
      return { intent: { type: "observe", locationId: action.locationId }, revision };
    case "talk":
      return { intent: { type: "talk", npcId: action.npcId }, revision };
    case "investigate":
      return { intent: { type: "investigate", factId: action.factId }, revision };
  }
}

export function SceneActionPanel({ view, onActionSuccess, onStaleRevision }: SceneActionPanelProps) {
  const [feedback, setFeedback] = useState<FeedbackState>({ phase: "idle" });

  const isSubmitting = feedback.phase === "submitting";

  async function handleAction(action: AvailableActionView) {
    setFeedback({ phase: "submitting" });

    const payload = buildIntentPayload(action, view.revision);

    try {
      const response = await fetch("/api/game/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const body = (await response.json().catch(() => null)) as ActionApiResponse | null;

      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        setFeedback({ phase: "error", message: "服务器返回了无法解析的响应，请重试。" });
        return;
      }

      // 成功：body 含 view + feedback。
      if ("view" in body && body.view !== undefined && "feedback" in body && body.feedback !== undefined) {
        if (body.feedback.ok) {
          setFeedback({ phase: "success", message: body.feedback.message });
          onActionSuccess(body.view);
          return;
        }
        // 规则拒绝：body 含 code: ACTION_REJECTED + view + feedback。
        setFeedback({ phase: "rejected", message: body.feedback.message });
        // 拒绝时 view 不变（仍为当前状态），但更新以防 availableActions 变化。
        // 实际上拒绝不改状态，所以不需要更新 view。
        return;
      }

      // 版本冲突：触发重新请求 current-game。
      if (body.code === "STALE_GAME_REVISION") {
        setFeedback({ phase: "error", message: "状态已更新，请重试。" });
        onStaleRevision();
        return;
      }

      // 其他错误码映射为可读消息。
      const errorMessages: Record<string, string> = {
        NO_ACTIVE_GAME: "没有可用的存档，请刷新页面。",
        CORRUPT_GAME: "存档数据已损坏，请刷新页面。",
        INFRASTRUCTURE_FAILURE: "本地服务暂时不可用，请稍后重试。",
        MALFORMED_JSON: "请求格式错误，请刷新页面。",
        UNEXPECTED_FIELDS: "请求包含未知字段，请刷新页面。",
        INVALID_INTENT: "行动意图不合法，请刷新页面。",
        INTERNAL_ERROR: "服务器内部错误，请稍后重试。"
      };
      const code = body.code ?? "";
      setFeedback({
        phase: "error",
        message: errorMessages[code] ?? "未知错误，请重试。"
      });
    } catch {
      setFeedback({ phase: "error", message: "网络异常，请检查连接后重试。" });
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
      {view.availableActions.length === 0 ? (
        <p className="action-hint">当前没有可执行的新行动。</p>
      ) : (
        <div className="action-buttons" role="group" aria-label="可用行动">
          {view.availableActions.map((action, index) => (
            <InlineButton
              key={`${action.type}-${index}`}
              onClick={() => void handleAction(action)}
              disabled={isSubmitting}
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
