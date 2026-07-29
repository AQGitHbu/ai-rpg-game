"use client";

import { useState } from "react";
import { InlineButton, Panel } from "@ai-game/ui";
import { generateTownDemoView } from "@/game/application";
import type { GenerateTownDemoResult } from "@/game/application";
import { TownMapSvg } from "@/components/town/TownMapSvg";
import { BuildingProfilePanel } from "@/components/town/BuildingProfilePanel";

// ---------------------------------------------------------------------------
// Town demo（Task 8）：/town-demo 演示页。
// 「生成」调 application 门面 generateTownDemoView（同步、确定性）；
// 「随机种子」只在 UI 层随机换 seed 文本（crypto.randomUUID），生成器
// 本身仍由 seed 完全确定；INVALID_SEED/GENERATION_FAILED 用 aria-live
// 错误文案呈现。独立 demo 页，不接入游戏主循环。
// ---------------------------------------------------------------------------

const ERROR_MESSAGES: Record<"INVALID_SEED" | "GENERATION_FAILED", string> = {
  INVALID_SEED: "种子无效：请输入 1–64 个字符（首尾空白不计）。",
  GENERATION_FAILED: "生成失败：该种子多次重试仍未通过验证，请换一个种子再试。"
};

export default function TownDemoPage() {
  const [seedText, setSeedText] = useState("demo-1");
  const [result, setResult] = useState<GenerateTownDemoResult | null>(null);
  const [selectedBuildingId, setSelectedBuildingId] = useState<string | null>(null);
  const [showPlotBorders, setShowPlotBorders] = useState(false);
  const [showRoadNodes, setShowRoadNodes] = useState(false);

  function handleGenerate() {
    setResult(generateTownDemoView(seedText));
    setSelectedBuildingId(null);
  }

  function handleRandomSeed() {
    setSeedText(crypto.randomUUID().slice(0, 8));
  }

  const view = result?.ok ? result.view : null;
  const selectedBuilding =
    view?.snapshot.buildings.find((building) => building.buildingId === selectedBuildingId) ?? null;

  return (
    <main className="town-demo-page">
      <header className="new-game-hero">
        <p className="new-game-kicker">TOWN GENERATION DEMO</p>
        <h1>小镇程序化生成 Demo</h1>
        <p>
          输入种子生成确定性小镇布局，点击地图上的建筑查看档案。
          建筑插图为程序生成的 SVG 占位图，未接入 AI 生图。
        </p>
      </header>

      <Panel eyebrow="生成控制" compact>
        <div className="town-demo-controls">
          <label className="town-demo-seed-label">
            种子
            <input
              value={seedText}
              onChange={(event) => setSeedText(event.target.value)}
              maxLength={80}
            />
          </label>
          <InlineButton onClick={handleGenerate}>生成</InlineButton>
          <InlineButton variant="outline" onClick={handleRandomSeed}>
            随机种子
          </InlineButton>
        </div>
        <div className="town-demo-toggles">
          <label className="town-demo-toggle">
            <input
              type="checkbox"
              checked={showPlotBorders}
              onChange={(event) => setShowPlotBorders(event.target.checked)}
            />
            显示地块边界
          </label>
          <label className="town-demo-toggle">
            <input
              type="checkbox"
              checked={showRoadNodes}
              onChange={(event) => setShowRoadNodes(event.target.checked)}
            />
            显示路网节点
          </label>
        </div>
        {result !== null && !result.ok && (
          <p role="alert" aria-live="polite" className="town-demo-error">
            {ERROR_MESSAGES[result.code]}
          </p>
        )}
      </Panel>

      {view === null ? (
        <p className="town-demo-empty">尚未生成小镇：输入种子后点击「生成」。</p>
      ) : (
        <>
          <p className="town-demo-stats" role="status">
            <span>种子 {view.snapshot.seed}</span>
            <span>建筑 {view.stats.buildingCount}</span>
            <span>剧情建筑 {view.stats.storyBuildingCount}</span>
            <span>地块 {view.stats.plotCount}</span>
            <span>占用 {view.stats.occupiedPlotCount}</span>
            <span>预留 {view.stats.reservedPlotCount}</span>
            <span>修复 {view.stats.repairCount}</span>
            <span>重试 {view.stats.retryCount}</span>
          </p>
          <div className="town-demo-layout">
            <TownMapSvg
              snapshot={view.snapshot}
              selectedBuildingId={selectedBuildingId}
              onSelectBuilding={setSelectedBuildingId}
              showPlotBorders={showPlotBorders}
              showRoadNodes={showRoadNodes}
            />
            <aside className="town-demo-side">
              {selectedBuilding === null ? (
                <p className="town-demo-empty">点击地图上的建筑查看档案。</p>
              ) : (
                <BuildingProfilePanel
                  building={selectedBuilding}
                  onClose={() => setSelectedBuildingId(null)}
                />
              )}
            </aside>
          </div>
        </>
      )}
    </main>
  );
}
