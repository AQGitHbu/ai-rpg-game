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
  readonly onOpen: (panel: DetailsPanel) => void;
  readonly developmentTools?: boolean;
  readonly onOpenDevTools?: () => void;
};

export function AdventureHud({ view, onOpen, developmentTools, onOpenDevTools }: AdventureHudProps) {
  const mainQuest = view.activeQuests.find((quest) => quest.kind === "main");
  const objective = mainQuest?.objectives.find((entry) => !entry.completed);

  return (
    <header className="adventure-hud">
      <div className="adventure-hud-info">
        <span className="adventure-hud-world">{view.world.name}</span>
        <span className="adventure-hud-location">{view.currentLocation.name}</span>
        <span className="adventure-hud-player">{view.player.name}</span>
        <span className="adventure-hud-hp">HP {view.player.stats.hp}</span>
        <span className="adventure-hud-quest">
          {mainQuest ? (
            <>
              {mainQuest.name}
              {objective ? <small>{objective.label}</small> : null}
            </>
          ) : (
            "暂无线索"
          )}
        </span>
      </div>
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
    </header>
  );
}
