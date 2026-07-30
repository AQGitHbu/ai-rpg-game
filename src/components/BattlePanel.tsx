"use client";

import { useState } from "react";
import type { GameSessionView, SessionActionView, BattleView } from "@/game/application";
import { postGameAction } from "./gameActionRequest";
import { BattleArena } from "./BattleArena";
import { BattleActionRail } from "./BattleActionRail";

// ---------------------------------------------------------------------------
// BattlePanel（Phase 9 Task 3）：战斗面板——场景化战斗主视窗。
// 使用 BattleArena 呈现战场背景、敌我肖像与 HP；BattleActionRail 呈现
// 固定行动栏。仍是唯一调用 postGameAction 的协调器：过滤 battle_action，
// 提交带 revision 的 payload，根据 API 结果显示反馈日志。
// 不引入本地 HP、回合或胜负状态——所有数值来自服务端 GameSessionView。
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
    <BattleArena
      gameType={view.world.gameType}
      playerName={view.player.name}
      playerHp={battle.playerHp}
      enemyName={battle.enemyName}
      enemyHp={battle.enemyHp}
      round={battle.round}
    >
      <BattleActionRail
        actions={battleActions}
        busy={disabled}
        onSelect={(action) => void handleBattleAction(action)}
      />
      {feedback.phase === "submitting" ? (
        <p role="status" aria-live="polite" className="battle-log battle-log--submitting">
          正在裁决本回合…
        </p>
      ) : null}
      {feedback.phase === "success" || feedback.phase === "rejected" || feedback.phase === "error" ? (
        <p
          role="status"
          aria-live="polite"
          aria-label="战斗日志"
          className={`battle-log battle-log--${feedback.phase}`}
        >
          {feedback.message}
        </p>
      ) : null}
    </BattleArena>
  );
}
