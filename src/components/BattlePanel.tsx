"use client";

import { useState } from "react";
import { Panel, Tag, InlineButton } from "@ai-game/ui";
import type { GameSessionView, SessionActionView, BattleView } from "@/game/application";
import { postGameAction } from "./gameActionRequest";

// ---------------------------------------------------------------------------
// BattlePanel（Phase 6 Task 4）：战斗面板。
// 只在 view.battle 非 null 时渲染；显示服务器 read model 给出的敌人名称、
// 双方血量与回合数；只渲染 battle_action 按钮（attack/guard/withdraw）；
// 提交带 revision 的 battle_action payload；提交期间禁用全部按钮；
// aria-live 报告规则反馈。
// 不得用前端逻辑自行减少 HP 或判断胜负——所有数值来自服务器。
// ---------------------------------------------------------------------------

type BattleActionView = Extract<SessionActionView, { type: "battle_action" }>;

type BattlePanelProps = {
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

export function BattlePanel({
  view,
  busy = false,
  onBusyChange,
  onActionSuccess,
  onStaleRevision
}: BattlePanelProps) {
  const [feedback, setFeedback] = useState<FeedbackState>({ phase: "idle" });

  const isSubmitting = feedback.phase === "submitting";
  const disabled = busy || isSubmitting;

  // 不渲染无战斗的面板
  if (view.battle === null) return null;

  const battle: BattleView = view.battle;
  const battleActions = view.availableActions.filter(
    (action): action is BattleActionView => action.type === "battle_action"
  );

  async function handleBattleAction(action: BattleActionView) {
    setFeedback({ phase: "submitting" });
    onBusyChange?.(true);

    const outcome = await postGameAction({
      intent: { type: "battle_action", action: action.action },
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
      data-battle-panel
      eyebrow="战斗"
      header={
        <div className="panel-heading">
          <h2>战斗中</h2>
          <Tag variant="danger">回合 {battle.round}</Tag>
        </div>
      }
    >
      <section className="battle-section" role="region" aria-label="战斗">
        <div className="battle-enemy-info">
          <h3>{battle.enemyName}</h3>
          <dl className="battle-stats">
            <div>
              <dt>敌方生命</dt>
              <dd>{battle.enemyHp}</dd>
            </div>
            <div>
              <dt>我方生命</dt>
              <dd>{battle.playerHp}</dd>
            </div>
            <div>
              <dt>当前回合</dt>
              <dd>{battle.round}</dd>
            </div>
          </dl>
        </div>

        <div className="action-buttons" role="group" aria-label="战斗行动">
          {battleActions.map((action) => (
            <InlineButton
              key={action.action}
              onClick={() => void handleBattleAction(action)}
              disabled={disabled}
            >
              {action.label}
            </InlineButton>
          ))}
        </div>
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
          正在战斗……
        </p>
      )}
    </Panel>
  );
}
