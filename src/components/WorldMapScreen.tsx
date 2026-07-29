"use client";

import { Panel, Tag } from "@ai-game/ui";
import type { GameSessionView, WorldMapNodeView } from "@/game/application";
import { AdventureVisual } from "./adventureVisuals";

// ---------------------------------------------------------------------------
// WorldMapScreen（Phase 7 Task 5）：旅行层的纯呈现组件。只渲染
// GameSessionView.worldMap 的封闭节点集合，自己不发任何请求：
//   current    → 进入{名称}，触发 onEnterCurrent（壳做纯本地切换）；
//   travelable → 前往{名称}，触发 onMove(locationId)（壳走 move 协议）；
//   known      → 禁用按钮，可访问名称 = 真实名称：需从相邻地点前往；
//   locked     → 禁用按钮，可访问名称 = 探寻未知之地：尚未解锁（零泄漏）。
// 所有节点一律是 <button>（键盘可达），节点视觉用装饰性 AdventureVisual，
// 可访问名称完全由文本 / aria-label 决定。busy 时行动按钮全部禁用。
// ---------------------------------------------------------------------------

type WorldMapScreenProps = {
  readonly view: GameSessionView;
  /** 点击当前地点：纯 UI 导航进入地点场景，不提交 move、不递增 revision。 */
  readonly onEnterCurrent: () => void;
  /** 点击可前往地点：由壳提交 move 规则裁决。 */
  readonly onMove: (locationId: string) => void;
  /** 壳或其他面板提交中：行动按钮一律禁用，避免并发写入。 */
  readonly busy: boolean;
};

function nodeKey(node: WorldMapNodeView, index: number): string {
  return node.state === "locked" ? `locked-${index}` : `${node.state}-${node.locationId}`;
}

export function WorldMapScreen({ view, onEnterCurrent, onMove, busy }: WorldMapScreenProps) {
  const gameType = view.world.gameType;

  return (
    <Panel
      eyebrow="世界地图"
      header={(
        <div className="panel-heading">
          <h2>{view.world.name}</h2>
          <Tag variant="info">当前：{view.currentLocation.name}</Tag>
        </div>
      )}
    >
      <div className="adventure-map" role="group" aria-label="世界地图节点">
        {view.worldMap.nodes.map((node, index) => {
          switch (node.state) {
            case "current":
              return (
                <button
                  key={nodeKey(node, index)}
                  type="button"
                  className="scene-hotspot"
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
                  className="scene-hotspot"
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
                  className="scene-hotspot"
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
                  className="scene-hotspot"
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
    </Panel>
  );
}
