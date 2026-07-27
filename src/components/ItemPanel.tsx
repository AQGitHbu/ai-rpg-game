"use client";

import { useState } from "react";
import { Panel, Tag, InlineButton } from "@ai-game/ui";
import type { GameSessionView, SessionActionView } from "@/game/application";
import { postGameAction } from "./gameActionRequest";

// ---------------------------------------------------------------------------
// ItemPanel（Phase 5 Task 4）：物品面板，含「可取得物品」与「背包」两个
// 业务区域。拾取按钮渲染 GameSessionView.availableActions 中的 take_item
// 行动（与 obtainableItems 摘要按 read model 顺序一一对应），名称/描述只
// 来自 read model，不 import blueprint/gameplay。提交/反馈模式与
// SceneActionPanel/TravelPanel 一致：提交期间禁用全部按钮、aria-live 提示
// 结果、成功后用最新 view 替换、版本冲突触发重新读取当前存档。
// 背包为纯展示区域：不渲染 use/give/trade 等未来阶段按钮。
// ---------------------------------------------------------------------------

type TakeItemActionView = Extract<SessionActionView, { type: "take_item" }>;

type ItemPanelProps = {
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

export function ItemPanel({
  view,
  busy = false,
  onBusyChange,
  onActionSuccess,
  onStaleRevision
}: ItemPanelProps) {
  const [feedback, setFeedback] = useState<FeedbackState>({ phase: "idle" });

  const isSubmitting = feedback.phase === "submitting";
  const disabled = busy || isSubmitting;

  const takeActions = view.availableActions.filter(
    (action): action is TakeItemActionView => action.type === "take_item"
  );

  async function handleTake(action: TakeItemActionView) {
    setFeedback({ phase: "submitting" });
    onBusyChange?.(true);

    const outcome = await postGameAction({
      intent: { type: "take_item", itemId: action.itemId },
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
      eyebrow="物品"
      header={(
        <div className="panel-heading">
          <h2>可取得物品与背包</h2>
          <Tag variant="info">Revision {view.revision}</Tag>
        </div>
      )}
    >
      <section className="item-section" aria-label="可取得物品">
        <h3>可取得物品</h3>
        {takeActions.length === 0 ? (
          <p className="action-hint">当前地点没有可取得的物品。</p>
        ) : (
          <ul className="item-list">
            {takeActions.map((action, index) => {
              // read model 保证 obtainableItems 与 take_item 行动一一对应。
              const item = view.obtainableItems[index];
              if (item === undefined) return null;
              return (
                <li key={action.itemId} className="item-entry">
                  <p className="item-summary">
                    <strong>{item.name}</strong>
                    <span className="item-description">{item.description}</span>
                  </p>
                  <InlineButton onClick={() => void handleTake(action)} disabled={disabled}>
                    {action.label}
                  </InlineButton>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="item-section" aria-label="背包">
        <h3>背包</h3>
        {view.inventoryItems.length === 0 ? (
          <p className="action-hint">背包目前是空的。</p>
        ) : (
          <ul className="item-list">
            {view.inventoryItems.map((item) => (
              <li key={item.name} className="item-entry">
                <p className="item-summary">
                  <strong>{item.name}</strong>
                  <span className="item-description">{item.description}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

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
          正在拾取物品……
        </p>
      )}
    </Panel>
  );
}
