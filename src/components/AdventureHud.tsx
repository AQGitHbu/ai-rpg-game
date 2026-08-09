"use client";

import type { CompatibilityGameSessionView } from "@/game/application";
import { CharacterAvatarIcon } from "./CharacterAvatarIcon";

export type DetailsPanel = "character" | "inventory" | "quests" | "journal";

const PANEL_LABELS: Record<DetailsPanel, string> = {
  character: "角色",
  inventory: "背包",
  quests: "任务",
  journal: "日志"
};

// 角色面板改由左上角头像打开，右下角信息入口只保留背包/任务/日志
const ACTION_PANELS: DetailsPanel[] = ["inventory", "quests", "journal"];

type AdventureHudProps = {
  readonly view: CompatibilityGameSessionView;
  readonly screen: "map" | "town" | "scene";
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
      <button
        type="button"
        className="adventure-hud-player-card"
        aria-label="打开角色面板"
        onClick={() => onOpen("character")}
      >
        <span className="adventure-hud-avatar" aria-hidden="true">
          <CharacterAvatarIcon />
        </span>
        <span><strong>{view.player.name}</strong><small>HP {view.player.stats.hp}</small></span>
      </button>
      {screen === "scene" ? <h1 className="adventure-hud-location-title">{view.locationScene.title}</h1> : null}
      {screen === "town" ? <h1 className="adventure-hud-location-title">{view.town?.townName ?? view.locationScene.title}</h1> : null}
      <aside className="adventure-hud-objective"><span>当前目标</span><strong>{objectiveText}</strong></aside>
      <nav className="adventure-hud-actions" aria-label="信息入口">
        {ACTION_PANELS.map((panel) => (
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
