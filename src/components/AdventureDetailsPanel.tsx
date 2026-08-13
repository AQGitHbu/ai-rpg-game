"use client";

import type { GameSessionView } from "@/game/application";
import type { DetailsPanel } from "./AdventureHud";
import { InventoryPanel } from "./InventoryPanel";

type AdventureDetailsPanelProps = {
  readonly view: GameSessionView;
  readonly panel: DetailsPanel;
};

const QUEST_STATUS_LABELS: Record<string, string> = {
  active: "进行中",
  completed: "已完成",
  locked: "未解锁",
  failed: "已失败",
};

const PACING_LABELS: Record<string, string> = {
  reveal: "铺垫线索",
  develop: "推进剧情",
  complicate: "制造变数",
  escalate: "升温冲突",
  climax: "迎接高潮",
  resolve: "收束伏线",
};

function questStatusClass(status: string): string {
  return `quest-status quest-status--${status}`;
}

export function AdventureDetailsPanel({ view, panel }: AdventureDetailsPanelProps) {
  if (panel === "journal") {
    return (
      <div className="details-journal">
        <section>
          <h3>旅途进度</h3>
          <p>
            第 {view.story.currentAct} / {view.story.targetActs} 幕 · 张力 {view.story.tension}%
            · 进度 {view.story.storyProgress}% · 已行动 {view.turnNumber} 回合
          </p>
        </section>
        <section>
          <h3>剧情节奏</h3>
          <p>{PACING_LABELS[view.story.pacingNeed] ?? view.story.pacingNeed}</p>
        </section>
        {view.setup.worldPremise !== null ? (
          <section>
            <h3>世界观</h3>
            <p>{view.setup.worldPremise}</p>
          </section>
        ) : null}
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
    return <InventoryPanel items={view.inventory} />;
  }

  if (panel === "quests") {
    return (
      <div className="details-quests">
        {view.quests.map((quest) => (
          <section key={quest.name} className={`quest-card ${quest.status === "active" ? "quest-card--active" : ""}`}>
            <h4>
              {quest.name}
              <span className={questStatusClass(quest.status)}>
                {QUEST_STATUS_LABELS[quest.status] ?? quest.status}
              </span>
            </h4>
            <p>{quest.description}</p>
            <ul>
              {quest.objectives.map((objective) => (
                <li key={objective.label} className={objective.completed ? "quest-objective--done" : ""}>
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

  const maxHp = view.player.maxHp ?? view.player.hp;
  const hpPercent = maxHp > 0 ? Math.max(0, Math.min(100, (view.player.hp / maxHp) * 100)) : 0;
  return (
    <div className="details-character">
      <dl className="details-character-stats">
        <div>
          <dt>姓名</dt>
          <dd>{view.player.name}</dd>
        </div>
        <div>
          <dt>身份</dt>
          <dd>{view.player.identity}</dd>
        </div>
        <div>
          <dt>攻击</dt>
          <dd>{view.player.attack}</dd>
        </div>
        <div>
          <dt>防御</dt>
          <dd>{view.player.defense}</dd>
        </div>
        <div>
          <dt>生命上限</dt>
          <dd>{maxHp}</dd>
        </div>
        <div>
          <dt>能量上限</dt>
          <dd>{view.player.maxEnergy ?? "—"}</dd>
        </div>
        <div>
          <dt>速度</dt>
          <dd>{view.player.speed ?? "—"}</dd>
        </div>
      </dl>
      <div className="details-character-hp" role="meter" aria-valuenow={hpPercent} aria-valuemin={0} aria-valuemax={100} aria-label="生命值">
        <span>生命 {view.player.hp}/{maxHp}</span>
        <div className="details-character-hp-bar" aria-hidden="true">
          <div style={{ width: `${hpPercent}%` }} />
        </div>
      </div>
      {view.setup.characterProfile !== null ? (
        <p className="details-character-profile">{view.setup.characterProfile}</p>
      ) : null}
    </div>
  );
}
