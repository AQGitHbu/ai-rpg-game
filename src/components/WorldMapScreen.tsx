"use client";

import type { GameSessionView, NewGameInput } from "@/game/application";
import { AdventureVisual } from "./adventureVisuals";

type WorldMapScreenProps = {
  readonly view: GameSessionView;
  readonly busy: boolean;
  readonly onEnterCurrent: () => void;
  readonly onMove: (choiceToken: string) => void;
};

/** CSS 中 .map-node[data-map-position] 预设的五个节点方位，按索引循环分配。 */
const MAP_POSITIONS = ["north_west", "north_east", "south_west", "south_east", "center"] as const;

export function WorldMapScreen({ view, busy, onEnterCurrent, onMove }: WorldMapScreenProps) {
  const gameType = view.gameType as NewGameInput["gameType"];

  return (
    <section data-testid="world-map-viewport" className="world-map-viewport" aria-label="世界地图">
      <div data-testid="world-map-backdrop" className="world-map-backdrop" aria-hidden="true">
        <AdventureVisual gameType={gameType} kind="map_base" label="" decorative />
      </div>
      <div className="world-map-nodes" role="group" aria-label="世界地图节点">
        {view.worldMap.locations.map((location, index) => {
          const position = MAP_POSITIONS[index % MAP_POSITIONS.length] ?? "center";
          if (location.current) {
            return (
              <button
                key={`current-${location.name}`}
                type="button"
                className="map-node"
                data-map-position={position}
                disabled={busy}
                onClick={onEnterCurrent}
              >
                <AdventureVisual gameType={gameType} kind="map_node" label={location.name} decorative />
                进入{location.name}
              </button>
            );
          }
          if (location.travelChoice !== null) {
            return (
              <button
                key={`travel-${location.name}`}
                type="button"
                className="map-node"
                data-map-position={position}
                disabled={busy}
                onClick={() => onMove(location.travelChoice!.choiceToken)}
              >
                <AdventureVisual gameType={gameType} kind="map_node" label={location.name} decorative />
                前往{location.name}
              </button>
            );
          }
          if (location.visited) {
            return (
              <button
                key={`visited-${location.name}`}
                type="button"
                className="map-node"
                data-map-position={position}
                disabled
                aria-label={`${location.name}：已到访`}
              >
                <AdventureVisual gameType={gameType} kind="map_node_locked" label={location.name} decorative />
                {location.name}（已到访）
              </button>
            );
          }
          return (
            <button
              key={`locked-${location.name}`}
              type="button"
              className="map-node"
              data-map-position={position}
              disabled
              aria-label={`${location.name}：未解锁`}
            >
              <AdventureVisual gameType={gameType} kind="map_node_locked" label={location.name} decorative />
              {location.name}（未解锁）
            </button>
          );
        })}
      </div>
    </section>
  );
}
