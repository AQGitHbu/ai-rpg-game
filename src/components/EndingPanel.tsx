"use client";

import { Panel, Tag } from "@ai-game/ui";
import type { GameSessionView } from "@/game/application";

// ---------------------------------------------------------------------------
// EndingPanel（Phase 6 Task 4）：结局面板。
// 只在 view.ending 非 null 时渲染；显示结局名称、描述与 outcome 标识。
// 成功结局与失败结局使用不同 Tag variant；结局后不渲染任何按钮或表单输入。
// 普通互动区不再可操作——availableActions 在投影层已为空数组。
// ---------------------------------------------------------------------------

type EndingPanelProps = {
  view: GameSessionView;
};

export function EndingPanel({ view }: EndingPanelProps) {
  if (view.ending === null) return null;

  const ending = view.ending;
  const isSuccess = ending.outcome === "success";

  return (
    <Panel
      data-ending-panel
      eyebrow="结局"
      header={
        <div className="panel-heading">
          <h2>{ending.name}</h2>
          <Tag variant={isSuccess ? "success" : "danger"}>
            {isSuccess ? "成功结局" : "失败结局"}
          </Tag>
        </div>
      }
    >
      <section className="ending-section" role="region" aria-label="结局">
        <p className="ending-description">{ending.description}</p>
      </section>
    </Panel>
  );
}
