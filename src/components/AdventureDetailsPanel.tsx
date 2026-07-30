"use client";

import type { GameSessionView } from "@/game/application";
import type { DetailsPanel } from "./AdventureHud";
import { InventoryPanel } from "./InventoryPanel";

type AdventureDetailsPanelProps = {
  readonly view: GameSessionView;
  readonly panel: DetailsPanel;
};

export function AdventureDetailsPanel({ view, panel }: AdventureDetailsPanelProps) {
  if (panel === "journal") {
    return (
      <div className="details-journal">
        <section>
          <h3>旅程开端</h3>
          <p>{view.openingNarration}</p>
        </section>
        <ul className="details-log">
          {view.storyEvents.map((event, index) => (
            <li key={`${index}-${event.text.slice(0, 20)}`}>{event.text}</li>
          ))}
          {view.storyEvents.length === 0 ? <li>尚无冒险记录。</li> : null}
        </ul>
      </div>
    );
  }

  if (panel === "inventory") {
    // 背包升级为四分类页签 + 图标网格 + 详情的专属界面（示意图 G）。
    return <InventoryPanel items={view.inventoryItems} />;
  }

  if (panel === "quests") {
    return (
      <div className="details-quests">
        {view.activeQuests.map((quest) => (
          <section key={quest.name}>
            <h4>{quest.name}</h4>
            <p>{quest.description}</p>
            <ul>
              {quest.objectives.map((objective) => (
                <li key={objective.label}>
                  {objective.completed ? "✓" : "○"} {objective.label}
                  {!objective.supported ? "（后续阶段）" : ""}
                </li>
              ))}
            </ul>
          </section>
        ))}
        {view.activeQuests.length === 0 ? <p>当前没有进行中的任务。</p> : null}
      </div>
    );
  }

  return (
    <dl className="details-character">
      <div>
        <dt>姓名</dt>
        <dd>{view.player.name}</dd>
      </div>
      <div>
        <dt>身份</dt>
        <dd>{view.player.identity}</dd>
      </div>
      <div>
        <dt>生命</dt>
        <dd>{view.player.stats.hp}</dd>
      </div>
      <div>
        <dt>攻击</dt>
        <dd>{view.player.stats.attack}</dd>
      </div>
      <div>
        <dt>防御</dt>
        <dd>{view.player.stats.defense}</dd>
      </div>
    </dl>
  );
}
