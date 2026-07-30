import type { SessionActionView } from "@/game/application";

// ---------------------------------------------------------------------------
// BattleActionRail（Phase 9 Task 2）：固定战斗行动栏。
// 只渲染服务端给出的 battle_action（attack/guard/withdraw），不显示技能、
// 物品等未来操作。busy 时禁用全部按钮。onSelect 转发原始 action entry，
// BattlePanel 无需重建 payload。
// ---------------------------------------------------------------------------

type BattleActionView = Extract<SessionActionView, { type: "battle_action" }>;

type BattleActionRailProps = {
  readonly actions: readonly BattleActionView[];
  readonly busy: boolean;
  readonly onSelect: (action: BattleActionView) => void;
};

const ACTION_ICON: Record<BattleActionView["action"], string> = {
  attack: "⚔",
  guard: "◈",
  withdraw: "↩"
};

export function BattleActionRail({ actions, busy, onSelect }: BattleActionRailProps) {
  return (
    <div className="battle-action-rail" role="group" aria-label="战斗行动">
      {actions.map((entry) => (
        <button key={entry.action} type="button" disabled={busy} onClick={() => onSelect(entry)}>
          <span aria-hidden="true">{ACTION_ICON[entry.action]}</span>
          {entry.label}
        </button>
      ))}
    </div>
  );
}
