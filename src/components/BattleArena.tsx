import type { ReactNode } from "react";
import type { NewGameInput } from "@/game/application";
import { AdventureVisual } from "./adventureVisuals";

// ---------------------------------------------------------------------------
// BattleArena（Phase 9 Task 1）：纯呈现的战斗主视窗。
// 只接收 gameType、playerName、playerHp、enemyName、enemyHp、round 和 children，
// 以只读方式投影为战场背景、敌我肖像与 HP 数值。
// 不持有 state、不发请求、不调用 action callback、不 import gameplay 模块、
// 不计算数值。HP 直接显示传入值，装饰性 SVG 由 AdventureVisual 提供。
// ---------------------------------------------------------------------------

type BattleArenaProps = {
  readonly gameType: NewGameInput["gameType"];
  readonly playerName: string;
  readonly playerHp: number;
  readonly enemyName: string;
  readonly enemyHp: number;
  readonly round: number;
  readonly children?: ReactNode;
};

export function BattleArena({
  gameType,
  playerName,
  playerHp,
  enemyName,
  enemyHp,
  round,
  children
}: BattleArenaProps) {
  return (
    <section className="battle-viewport" role="region" aria-label="战斗">
      <div className="battle-arena-backdrop">
        <AdventureVisual gameType={gameType} kind="location_backdrop" label="" decorative />
      </div>
      <header className="battle-hud">
        <span>战斗中</span>
        <strong>{enemyName}</strong>
        <span>回合 {round}</span>
      </header>
      <section className="battle-combatant battle-combatant--player">
        <div data-testid="battle-combatant-visual">
          <AdventureVisual gameType={gameType} kind="npc" label="" decorative />
        </div>
        <h3>{playerName}</h3>
        <p>生命 {playerHp}</p>
      </section>
      <section className="battle-combatant battle-combatant--enemy">
        <div data-testid="battle-combatant-visual">
          <AdventureVisual gameType={gameType} kind="enemy" label="" decorative />
        </div>
        <h3>{enemyName}</h3>
        <p>生命 {enemyHp}</p>
      </section>
      {children}
    </section>
  );
}
