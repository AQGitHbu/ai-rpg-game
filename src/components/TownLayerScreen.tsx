"use client";

import { useState } from "react";
import { InlineButton } from "@ai-game/ui";
import type { TownLayerView } from "@/game/application";
import { TownMapSvg } from "./town/TownMapSvg";

// ---------------------------------------------------------------------------
// Town 层（第三层入口）：小镇逻辑地图 + 语义方位句子。
// 复用 demo 的 TownMapSvg 渲染确定性快照（默认叠加 demo 预生成的建筑
// 俯视贴图占位，见 public/assets/town-experiment/）；点击剧情建筑（buildingKey =
// story_npc_<npcId>）触发纯 UI 导航——打开该地点既有场景视图并聚焦所绑定
// NPC 的对话（onEnterBuilding(npcId)）。非剧情建筑只做选中高亮，无导航。
// 本阶段不新增 enter_building intent、不改 GameState 位置指针粒度。
// ---------------------------------------------------------------------------

type TownLayerScreenProps = {
  readonly town: TownLayerView;
  readonly busy: boolean;
  readonly onEnterBuilding: (npcId: string) => void;
  readonly onReturnMap: () => void;
};

export function TownLayerScreen({ town, busy, onEnterBuilding, onReturnMap }: TownLayerScreenProps) {
  const [selectedBuildingId, setSelectedBuildingId] = useState<string | null>(null);
  // Phase 14：可进入的剧情建筑 ID 集合——传给 TownMapSvg 以渲染未探索占位。
  const interactiveBuildingIds = new Set(town.interactiveBuildings.map((entry) => entry.buildingId));
  const selectedInteractive =
    selectedBuildingId === null
      ? null
      : town.interactiveBuildings.find((entry) => entry.buildingId === selectedBuildingId) ?? null;
  // Phase 14：选中了未探索的剧情建筑（storyRequired 但被入口过滤排除）。
  const selectedUnexplored =
    selectedBuildingId !== null &&
    selectedInteractive === null &&
    town.snapshot.buildings.some(
      (entry) => entry.buildingId === selectedBuildingId && entry.storyRequired
    );

  return (
    <section className="town-layer-viewport" aria-label={`小镇：${town.townName}`}>
      <header className="town-layer-header">
        <h2>{town.townName}</h2>
        <InlineButton onClick={onReturnMap} disabled={busy}>
          返回地图
        </InlineButton>
      </header>

      <div className="town-layer-body">
        <TownMapSvg
          snapshot={town.snapshot}
          selectedBuildingId={selectedBuildingId}
          onSelectBuilding={setSelectedBuildingId}
          showAiBuildingArt
          interactiveBuildingIds={interactiveBuildingIds}
        />

        <aside className="town-layer-side">
          {selectedInteractive !== null ? (
            <div className="town-layer-building" role="group" aria-label="剧情建筑">
              <h3>{selectedInteractive.displayName}</h3>
              <InlineButton
                onClick={() => onEnterBuilding(selectedInteractive.npcIds[0]!)}
                disabled={busy}
              >
                进入{selectedInteractive.displayName}
              </InlineButton>
            </div>
          ) : selectedUnexplored ? (
            <p className="town-layer-hint" role="status">未探索</p>
          ) : (
            <p className="town-layer-hint">点击地图上高亮的剧情建筑，进入其中的场景与对话。</p>
          )}

          <ul className="town-layer-sentences" aria-label="方位关系">
            {town.semanticView.sentences.map((sentence) => (
              <li key={sentence}>{sentence}</li>
            ))}
          </ul>
        </aside>
      </div>
    </section>
  );
}
