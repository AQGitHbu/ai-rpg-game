"use client";

import { useState } from "react";
import { InlineButton } from "@ai-game/ui";
import type { GameSessionView } from "@/game/application";

type DetailsTab = "character" | "inventory" | "quests" | "log";

const TAB_LABELS: Record<DetailsTab, string> = {
  character: "角色",
  inventory: "背包",
  quests: "任务",
  log: "日志"
};

type AdventureDetailsPanelProps = {
  readonly view: GameSessionView;
};

export function AdventureDetailsPanel({ view }: AdventureDetailsPanelProps) {
  const [tab, setTab] = useState<DetailsTab>("character");

  return (
    <div className="adventure-details" aria-label="冒险详情面板">
      <div role="group" aria-label="详情分类">
        {(Object.keys(TAB_LABELS) as DetailsTab[]).map((key) => (
          <InlineButton
            key={key}
            aria-pressed={tab === key}
            onClick={() => setTab(key)}
          >
            {TAB_LABELS[key]}
          </InlineButton>
        ))}
      </div>

      <div aria-label={TAB_LABELS[tab]}>
        {tab === "character" ? (
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
        ) : null}

        {tab === "inventory" ? (
          <ul className="details-inventory">
            {view.inventoryItems.map((item) => (
              <li key={item.name}>
                <strong>{item.name}</strong>：{item.description}
              </li>
            ))}
            {view.inventoryItems.length === 0 ? <li>背包空空如也。</li> : null}
          </ul>
        ) : null}

        {tab === "quests" ? (
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
        ) : null}

        {tab === "log" ? (
          <ul className="details-log">
            {view.storyEvents.map((event, index) => (
              <li key={`${index}-${event.text.slice(0, 20)}`}>{event.text}</li>
            ))}
            {view.storyEvents.length === 0 ? <li>尚无冒险记录。</li> : null}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
