"use client";

import type { GameSessionView } from "@/game/application";

export type DetailsPanel = "character" | "inventory" | "quests" | "journal";

const PANEL_LABELS: Record<DetailsPanel, string> = {
  character: "角色",
  inventory: "背包",
  quests: "任务",
  journal: "日志"
};

type AdventureHudProps = {
  readonly view: GameSessionView;
  readonly screen: "map" | "scene";
  readonly onOpen: (panel: DetailsPanel) => void;
  readonly developmentTools?: boolean;
  readonly onOpenDevTools?: () => void;
};

export function AdventureHud({ view, screen, onOpen, developmentTools, onOpenDevTools }: AdventureHudProps) {
  const mainQuest = view.activeQuests.find((quest) => quest.kind === "main");
  const objective = mainQuest?.objectives.find((entry) => !entry.completed);
  const objectiveText = objective ? objective.label : "暂无线索";

  return (
    <div className="adventure-hud-layer" aria-label="游戏 HUD">
      <div className="adventure-hud-player-card">
        <span className="adventure-hud-avatar" aria-hidden="true">
          <svg viewBox="0 0 64 64" focusable="false" aria-hidden="true"><circle cx="32" cy="32" r="30" /><circle cx="32" cy="25" r="11" /><path d="M12 56c4-13 12-19 20-19s16 6 20 19" /></svg>
        </span>
        <span><strong>{view.player.name}</strong><small>HP {view.player.stats.hp}</small></span>
      </div>
      {screen === "scene" ? <h1 className="adventure-hud-location-title">{view.locationScene.title}</h1> : null}
      <aside className="adventure-hud-objective"><span>当前目标</span><strong>{objectiveText}</strong></aside>
      <nav className="adventure-hud-actions" aria-label="信息入口">
        {(Object.keys(PANEL_LABELS) as DetailsPanel[]).map((panel) => (
          <button key={panel} type="button" onClick={() => onOpen(panel)}>
            {PANEL_LABELS[panel]}
          </button>
        ))}
        {developmentTools ? (
          <button type="button" onClick={() => onOpenDevTools?.()}>
            开发工具
          </button>
        ) : null}
      </nav>
    </div>
  );
}
