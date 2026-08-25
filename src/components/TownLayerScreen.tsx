"use client";

import { useState } from "react";
import { InlineButton } from "@ai-game/ui";
import type { TownView } from "@/game/application";
import { TownMapSvg } from "./town/TownMapSvg";

// ---------------------------------------------------------------------------
// Town 层（第三层入口）：小镇逻辑地图 + 已绑定建筑交互入口。
// 点击剧情建筑→选中侧边栏→进入建筑触发 onEnterBuilding(npcId, token?)→
// 普通建筑只打开场景；事实目标建筑还会消费服务端下发的规则 token。
// ---------------------------------------------------------------------------

type TownLayerScreenProps = {
  readonly town: TownView;
  readonly busy: boolean;
  readonly onEnterBuilding: (npcId: string, arrivalChoiceToken?: string) => void;
  readonly onReturnMap: () => void;
};

export function TownLayerScreen({ town, busy, onEnterBuilding, onReturnMap }: TownLayerScreenProps) {
  const [selectedBuildingId, setSelectedBuildingId] = useState<string | null>(null);
  const interactiveBuildingIds = new Set(town.interactiveBuildings.map((entry) => entry.buildingId));
  const selectedInteractive =
    selectedBuildingId === null
      ? null
      : town.interactiveBuildings.find((entry) => entry.buildingId === selectedBuildingId) ?? null;

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
          interactiveBuildingIds={interactiveBuildingIds}
        />

        <aside className="town-layer-side">
          <div className="town-layer-legend" aria-label="地图图例">
            <span className="town-layer-legend-title">地图图例</span>
            <span className="town-layer-legend-item">
              <i className="town-layer-legend-swatch" aria-hidden="true" />
              可进入建筑
            </span>
          </div>
          {selectedInteractive !== null ? (
            <div className="town-layer-building" role="group" aria-label="剧情建筑">
              {selectedInteractive.isCurrentFocus ? (
                <span className="town-layer-story-badge">当前剧情</span>
              ) : null}
              <h3>{selectedInteractive.displayName}</h3>
              <p>{selectedInteractive.npcName}</p>
              <InlineButton
                onClick={() => {
                  if (selectedInteractive.arrivalChoiceToken === undefined) {
                    onEnterBuilding(selectedInteractive.npcId);
                  } else {
                    onEnterBuilding(selectedInteractive.npcId, selectedInteractive.arrivalChoiceToken);
                  }
                }}
                disabled={busy}
              >
                进入{selectedInteractive.displayName}
              </InlineButton>
            </div>
          ) : (
            <p className="town-layer-hint">点击地图上的高亮建筑，查看其中的人物并进入场景。</p>
          )}
        </aside>
      </div>
    </section>
  );
}
