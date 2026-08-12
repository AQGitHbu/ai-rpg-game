"use client";

import type { GameSessionView } from "@/game/application";

export type DetailsPanel = "character" | "inventory" | "quests" | "journal";

const PANEL_LABELS: Record<DetailsPanel, string> = {
  character: "角色",
  inventory: "背包",
  quests: "任务",
  journal: "日志",
};

type AdventureHudProps = {
  readonly view: GameSessionView;
  readonly screen: "map" | "town" | "scene";
  readonly onOpen: (panel: DetailsPanel) => void;
  readonly developmentTools: boolean;
  readonly onOpenDevTools: () => void;
};

/** 当前目标推导：优先进行中主线；主线全部完成时回退任意未完成任务。 */
function deriveObjective(view: GameSessionView): string {
  if (view.story.currentObjectiveLabel !== null) {
    return view.story.currentObjectiveLabel;
  }

  const activeMain = view.quests.find((quest) => quest.kind === "main" && quest.status === "active");
  const nextMain = view.quests.find((quest) => quest.kind === "main" && quest.status !== "completed" && quest.status !== "failed");
  const quest = activeMain ?? nextMain ?? view.quests.find((entry) => entry.status === "active");
  const objective = quest?.objectives.find((entry) => !entry.completed);
  if (objective !== undefined) return objective.label;
  if (view.ending === null && view.story.storyProgress >= 100) return "结局生成中";
  return "暂无线索";
}

export function AdventureHud({ view, screen, onOpen, developmentTools, onOpenDevTools }: AdventureHudProps) {
  const objectiveText = deriveObjective(view);
  const inTown = screen === "scene" && view.currentLocation.scale === "town";

  return (
    <div className="adventure-hud-layer" aria-label="游戏 HUD">
      <div className="adventure-hud-topbar">
        <button
          type="button"
          className="adventure-hud-player-card"
          onClick={() => onOpen("character")}
        >
          <span className="adventure-hud-avatar" aria-hidden="true">
            <svg viewBox="0 0 64 64" focusable="false" aria-hidden="true">
              <circle cx="32" cy="32" r="30" />
              <circle cx="32" cy="25" r="11" />
              <path d="M12 56c4-13 12-19 20-19s16 6 20 19" />
            </svg>
          </span>
          <span>
            <strong>{view.player.name}</strong>
            <small>HP {view.player.hp}</small>
          </span>
        </button>

        <div className="adventure-hud-center">
          {screen === "scene" ? (
            <h1 className="adventure-hud-location-title">
              {view.currentLocation.name}
              {inTown ? <small className="adventure-hud-location-scale" aria-hidden="true">小镇</small> : null}
            </h1>
          ) : screen === "town" ? (
            <h1 className="adventure-hud-location-title">
              {view.currentLocation.name}
              <small className="adventure-hud-location-scale" aria-hidden="true">小镇</small>
            </h1>
          ) : (
            <h1 className="adventure-hud-location-title">世界地图</h1>
          )}
          <span className="adventure-hud-turn">回合 {view.turnNumber}</span>
        </div>

        <nav className="adventure-hud-actions" aria-label="信息入口">
          {(Object.keys(PANEL_LABELS) as DetailsPanel[]).map((panel) => (
            <button key={panel} type="button" onClick={() => onOpen(panel)}>
              {PANEL_LABELS[panel]}
            </button>
          ))}
          {developmentTools ? (
            <button type="button" onClick={() => onOpenDevTools()}>
              开发工具
            </button>
          ) : null}
        </nav>
      </div>

      <aside className="adventure-hud-objective">
        <span>当前目标</span>
        <strong>{objectiveText}</strong>
      </aside>
    </div>
  );
}
