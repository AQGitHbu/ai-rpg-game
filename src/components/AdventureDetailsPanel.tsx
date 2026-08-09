"use client";

import type { GameSessionView } from "@/game/application";
import type { DetailsPanel } from "./AdventureHud";

type AdventureDetailsPanelProps = {
  readonly view: GameSessionView;
  readonly panel: DetailsPanel;
};

export function AdventureDetailsPanel({ view, panel }: AdventureDetailsPanelProps) {
  if (panel === "journal") {
    return (
      <div className="details-journal">
        <section>
          <h3>旅途进度</h3>
          <p>
            第 {view.story.currentAct} / {view.story.targetActs} 幕 · 张力 {view.story.tension}%
            · 进度 {view.story.storyProgress}%
          </p>
        </section>
        <section>
          <h3>节奏需要</h3>
          <p>{view.story.pacingNeed}</p>
        </section>
        {view.narrative.narration ? (
          <section>
            <h3>最近一幕</h3>
            <p>{view.narrative.narration}</p>
          </section>
        ) : null}
      </div>
    );
  }

  if (panel === "inventory") {
    return (
      <ul className="details-inventory">
        {view.inventory.map((item) => (
          <li key={item.name}>
            <strong>{item.name}</strong>：{item.description}
          </li>
        ))}
        {view.inventory.length === 0 ? <li>背包空空如也。</li> : null}
      </ul>
    );
  }

  if (panel === "quests") {
    return (
      <div className="details-quests">
        {view.quests.map((quest) => (
          <section key={quest.name}>
            <h4>{quest.name} · {quest.status}</h4>
            <p>{quest.description}</p>
            <ul>
              {quest.objectives.map((objective) => (
                <li key={objective.label}>
                  {objective.completed ? "✓" : "○"} {objective.label}
                </li>
              ))}
            </ul>
          </section>
        ))}
        {view.quests.length === 0 ? <p>当前没有进行中的任务。</p> : null}
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
        <dd>{view.player.hp}</dd>
      </div>
      <div>
        <dt>攻击</dt>
        <dd>{view.player.attack}</dd>
      </div>
      <div>
        <dt>防御</dt>
        <dd>{view.player.defense}</dd>
      </div>
    </dl>
  );
}
