"use client";

import { InlineButton, Panel, Tag } from "@ai-game/ui";
import type { TownBuilding } from "@/game/application";
import { BuildingPlaceholderArt, TOWN_BUILDING_TYPE_LABELS } from "./BuildingPlaceholderArt";

// ---------------------------------------------------------------------------
// Town demo（Task 8）：建筑档案面板。
// Panel 内展示名称/类型/区域/命名状态/占地/入口方位 + SVG 占位外观图；
// 用 warning Tag 明示「AI 生图未接入（预留接口）」（用户硬约束：本 demo
// 不接入任何 AI 生图，插图一律程序生成的 SVG 占位图）。
// ---------------------------------------------------------------------------

const DISTRICT_LABELS: Record<TownBuilding["district"], string> = {
  market: "集市区",
  residential: "居住区",
  craft: "工坊区",
  reserved: "预留区"
};

const DEFINITION_STATE_LABELS: Record<TownBuilding["definitionState"], string> = {
  generic: "泛化占位",
  named: "已命名"
};

const DIRECTION_LABELS: Record<TownBuilding["entrance"]["direction"], string> = {
  north: "北",
  south: "南",
  east: "东",
  west: "西"
};

export function BuildingProfilePanel({
  building,
  onClose
}: {
  building: TownBuilding;
  onClose: () => void;
}) {
  return (
    <Panel
      className="town-demo-profile"
      eyebrow="建筑档案"
      header={
        <div className="panel-heading">
          <h2>{building.displayName}</h2>
          {building.storyRequired && <Tag variant="accent">剧情建筑</Tag>}
        </div>
      }
    >
      <BuildingPlaceholderArt buildingType={building.buildingType} seed={building.buildingId} />
      <Tag variant="warning">AI 生图未接入（预留接口）</Tag>

      <dl className="town-demo-profile-facts">
        <div>
          <dt>类型</dt>
          <dd>{TOWN_BUILDING_TYPE_LABELS[building.buildingType]}</dd>
        </div>
        <div>
          <dt>区域</dt>
          <dd>{DISTRICT_LABELS[building.district]}</dd>
        </div>
        <div>
          <dt>命名状态</dt>
          <dd>{DEFINITION_STATE_LABELS[building.definitionState]}</dd>
        </div>
        <div>
          <dt>占地</dt>
          <dd>
            {building.footprint.width} × {building.footprint.height} 格
          </dd>
        </div>
        <div>
          <dt>入口方位</dt>
          <dd>
            {DIRECTION_LABELS[building.entrance.direction]}（{building.entrance.x},{" "}
            {building.entrance.y}）
          </dd>
        </div>
      </dl>

      <InlineButton variant="outline" size="sm" onClick={onClose}>
        关闭档案
      </InlineButton>
    </Panel>
  );
}
