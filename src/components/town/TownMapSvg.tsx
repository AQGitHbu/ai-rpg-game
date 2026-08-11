"use client";

import type { KeyboardEvent, MouseEvent } from "react";
import { tileIndex, type TileType, type TownRenderSnapshot } from "@/game/application";

// ---------------------------------------------------------------------------
// Town 层 SVG 逻辑地图（Task 7 恢复）：渲染完全由 snapshot 确定性驱动
// （无 Math.random/Date）。底图每格一个 rect（fill 按 TileType 色表）；
// 每座建筑叠加一个可点击矩形（aria-label=displayName），storyRequired 加高亮描边；
// 点击空白处 onSelectBuilding(null)。storyRequired 但不在 interactiveBuildingIds
// 中的建筑渲染为「未探索」占位灰块，不展示真实名称，避免泄漏未结识 NPC 信息。
// ---------------------------------------------------------------------------

/** 每个网格瓦片的边长（SVG 用户单位）。 */
const TILE_SIZE = 12;

/** TileType → 填充色。 */
const TILE_FILL: Record<TileType, string> = {
  outside: "#1a1d24",
  grass: "#3d5a3a",
  forest: "#2c4630",
  water: "#2a4d6e",
  road_main: "#b8a888",
  road_minor: "#8f836c",
  alley: "#6e6454",
  square: "#c9b98f",
  plot: "#4a4438",
  building: "#7d6b58",
  building_entrance: "#d9a441",
  reserved: "#55504a",
};

type TownMapSvgProps = {
  readonly snapshot: TownRenderSnapshot;
  readonly selectedBuildingId: string | null;
  readonly onSelectBuilding: (buildingId: string | null) => void;
  readonly showPlotBorders?: boolean;
  readonly showRoadNodes?: boolean;
  /**
   * 可进入的剧情建筑 ID 集合。未提供时所有 storyRequired 建筑视为可进入；
   * 提供时 storyRequired 且不在集合中的建筑渲染为「未探索」占位灰块。
   */
  readonly interactiveBuildingIds?: ReadonlySet<string>;
};

export function TownMapSvg({
  snapshot,
  selectedBuildingId,
  onSelectBuilding,
  showPlotBorders = false,
  showRoadNodes = false,
  interactiveBuildingIds,
}: TownMapSvgProps) {
  const { grid } = snapshot;
  const viewWidth = grid.width * TILE_SIZE;
  const viewHeight = grid.height * TILE_SIZE;

  function isUnexploredPlaceholder(building: {
    readonly buildingId: string;
    readonly storyRequired: boolean;
  }): boolean {
    if (!building.storyRequired) return false;
    if (interactiveBuildingIds === undefined) return false;
    return !interactiveBuildingIds.has(building.buildingId);
  }

  function handleBuildingClick(event: MouseEvent, buildingId: string) {
    event.stopPropagation();
    onSelectBuilding(buildingId);
  }

  function handleBuildingKeyDown(event: KeyboardEvent, buildingId: string) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    onSelectBuilding(buildingId);
  }

  const tiles = [];
  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      const tile = grid.tiles[tileIndex(grid, x, y)];
      tiles.push(
        <rect
          key={`${x}-${y}`}
          className="town-demo-tile"
          x={x * TILE_SIZE}
          y={y * TILE_SIZE}
          width={TILE_SIZE}
          height={TILE_SIZE}
          fill={TILE_FILL[tile]}
        />
      );
    }
  }

  return (
    <svg
      data-town-map
      role="img"
      className="town-demo-map"
      viewBox={`0 0 ${viewWidth} ${viewHeight}`}
      aria-label="小镇地图"
      onClick={() => onSelectBuilding(null)}
    >
      {tiles}

      {showPlotBorders && (
        <g data-plot-borders>
          {snapshot.plots.map((plot) =>
            plot.cells.map((cell) => (
              <rect
                key={`${plot.id}-${cell.x}-${cell.y}`}
                x={cell.x * TILE_SIZE + 0.5}
                y={cell.y * TILE_SIZE + 0.5}
                width={TILE_SIZE - 1}
                height={TILE_SIZE - 1}
                fill="none"
                stroke="#f3ead5"
                strokeOpacity={0.4}
                strokeWidth={1}
              />
            ))
          )}
        </g>
      )}

      {showRoadNodes && (
        <g data-road-nodes>
          {snapshot.roadGraph.nodes.map((node) => (
            <circle
              key={node.id}
              cx={node.x * TILE_SIZE + TILE_SIZE / 2}
              cy={node.y * TILE_SIZE + TILE_SIZE / 2}
              r={3}
              fill="#f3ead5"
              stroke="#1a1d24"
              strokeWidth={1}
            />
          ))}
        </g>
      )}

      {snapshot.buildings.map((building) => {
        if (isUnexploredPlaceholder(building)) {
          const selected = building.buildingId === selectedBuildingId;
          const classes = ["town-demo-building", "town-demo-building--unexplored"];
          if (selected) classes.push("town-demo-building--selected");
          return (
            <rect
              key={building.buildingId}
              className={classes.join(" ")}
              role="button"
              tabIndex={0}
              aria-label="未探索"
              aria-pressed={selected}
              aria-disabled="true"
              x={building.footprint.x * TILE_SIZE}
              y={building.footprint.y * TILE_SIZE}
              width={building.footprint.width * TILE_SIZE}
              height={building.footprint.height * TILE_SIZE}
              onClick={(event) => handleBuildingClick(event, building.buildingId)}
              onKeyDown={(event) => handleBuildingKeyDown(event, building.buildingId)}
            />
          );
        }
        const selected = building.buildingId === selectedBuildingId;
        const classes = ["town-demo-building"];
        if (building.storyRequired) classes.push("town-demo-building--story");
        if (selected) classes.push("town-demo-building--selected");
        return (
          <rect
            key={building.buildingId}
            className={classes.join(" ")}
            role="button"
            tabIndex={0}
            aria-label={building.displayName}
            aria-pressed={selected}
            x={building.footprint.x * TILE_SIZE}
            y={building.footprint.y * TILE_SIZE}
            width={building.footprint.width * TILE_SIZE}
            height={building.footprint.height * TILE_SIZE}
            onClick={(event) => handleBuildingClick(event, building.buildingId)}
            onKeyDown={(event) => handleBuildingKeyDown(event, building.buildingId)}
          />
        );
      })}
    </svg>
  );
}
