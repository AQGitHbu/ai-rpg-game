"use client";

import type { GameSessionView, WorldMapNodeView } from "@/game/application";
import { AdventureVisual } from "./adventureVisuals";

type WorldMapScreenProps = {
  readonly view: GameSessionView;
  readonly onEnterCurrent: () => void;
  readonly onMove: (locationId: string) => void;
  readonly busy: boolean;
};

function nodeKey(node: WorldMapNodeView, index: number): string {
  return node.state === "locked" ? `locked-${index}` : `${node.state}-${node.locationId}`;
}

export function WorldMapScreen({ view, onEnterCurrent, onMove, busy }: WorldMapScreenProps) {
  const gameType = view.world.gameType;
  const mainQuest = view.activeQuests.find((quest) => quest.kind === "main");
  const objective = mainQuest?.objectives.find((entry) => !entry.completed);
  const objectiveText = objective ? objective.label : "暂无线索";

  return (
    <section data-testid="world-map-viewport" className="world-map-viewport" aria-label="世界地图">
      <div data-testid="world-map-backdrop" className="world-map-backdrop" aria-hidden="true">
        <AdventureVisual gameType={gameType} kind="map_base" label="" decorative />
      </div>
      <aside className="map-objective-card">
        <span>当前目标</span>
        <strong>{objectiveText}</strong>
      </aside>
      <div className="world-map-nodes" role="group" aria-label="世界地图节点">
        {view.worldMap.nodes.map((node, index) => {
          switch (node.state) {
            case "current":
              return (
                <button
                  key={nodeKey(node, index)}
                  type="button"
                  className="map-node"
                  data-map-position={node.position}
                  disabled={busy}
                  onClick={onEnterCurrent}
                >
                  <AdventureVisual gameType={gameType} kind={node.visual} label={node.name} decorative />
                  进入{node.name}
                </button>
              );
            case "travelable":
              return (
                <button
                  key={nodeKey(node, index)}
                  type="button"
                  className="map-node"
                  data-map-position={node.position}
                  disabled={busy}
                  onClick={() => onMove(node.locationId)}
                >
                  <AdventureVisual gameType={gameType} kind={node.visual} label={node.name} decorative />
                  前往{node.name}
                </button>
              );
            case "known":
              return (
                <button
                  key={nodeKey(node, index)}
                  type="button"
                  className="map-node"
                  data-map-position={node.position}
                  disabled
                  aria-label={`${node.name}：${node.hint}`}
                >
                  <AdventureVisual gameType={gameType} kind={node.visual} label={node.name} decorative />
                  {node.name}（{node.hint}）
                </button>
              );
            case "locked":
              return (
                <button
                  key={nodeKey(node, index)}
                  type="button"
                  className="map-node"
                  data-map-position={node.position}
                  disabled
                  aria-label={`${node.name}：${node.hint}`}
                >
                  <AdventureVisual gameType={gameType} kind={node.visual} label={node.name} decorative />
                  {node.name}（{node.hint}）
                </button>
              );
          }
        })}
      </div>
    </section>
  );
}
