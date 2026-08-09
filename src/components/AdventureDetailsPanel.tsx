"use client";

import type { CompatibilityGameSessionView } from "@/game/application";
import type { DetailsPanel } from "./AdventureHud";
import { CharacterAvatarIcon } from "./CharacterAvatarIcon";
import { InventoryPanel } from "./InventoryPanel";

type AdventureDetailsPanelProps = {
  readonly view: CompatibilityGameSessionView;
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
        {view.storyContinuity.length > 0 ? (
          <section>
            <h3>本章进展</h3>
            <ul className="details-continuity">
              {view.storyContinuity.map((item, index) => (
                <li key={`continuity-${index}-${item.text.slice(0, 20)}`}>{item.text}</li>
              ))}
            </ul>
          </section>
        ) : null}
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

  return <CharacterPanel view={view} />;
}

// 扩展属性插槽：玩家属性字典暂无扩展数据时展示的缺省基准值（规范 2.3），
// 非来自 view.player，后续接入真实衍生数值时替换为数据驱动。
const EXTENDED_STAT_SLOTS = [
  { label: "速度", value: "10" },
  { label: "暴击率", value: "5%" },
  { label: "闪避率", value: "5%" }
] as const;

function CharacterPanel({ view }: { readonly view: CompatibilityGameSessionView }) {
  const { player } = view;

  return (
    <div className="details-character-landscape">
      <div className="character-card-portrait">
        <div className="character-avatar-frame" aria-hidden="true">
          <CharacterAvatarIcon />
        </div>
        <div className="character-identity-info">
          <h3 className="character-name">{player.name}</h3>
          <span className="character-tag">{player.identity}</span>
          <div className="character-level-badge">等级 1</div>
        </div>
      </div>

      <div className="character-card-stats">
        {/* 当前领域模型无 maxHP 字段，血条暂按满值显示（规范 2.3 的 MVP 近似）。 */}
        <section className="character-vitals-section">
          <div className="character-stat-bar-header">
            <span className="stat-label">生命 (HP)</span>
            <span className="stat-value">
              {player.stats.hp} / {player.stats.hp}
            </span>
          </div>
          <div
            className="character-stat-bar"
            role="progressbar"
            aria-label="生命值"
            aria-valuenow={100}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="character-stat-bar-fill" style={{ width: "100%" }} />
          </div>
        </section>

        <section className="character-attributes-section">
          <h4>基础属性</h4>
          <div className="character-stats-grid">
            <div className="stat-card">
              <span className="stat-card-label">攻击</span>
              <span className="stat-card-value">{player.stats.attack}</span>
            </div>
            <div className="stat-card">
              <span className="stat-card-label">防御</span>
              <span className="stat-card-value">{player.stats.defense}</span>
            </div>
          </div>
        </section>

        <section className="character-attributes-section">
          <h4>拓展属性</h4>
          <div className="character-stats-grid">
            {EXTENDED_STAT_SLOTS.map((slot) => (
              <div key={slot.label} className="stat-card stat-card-extended">
                <span className="stat-card-label">{slot.label}</span>
                <span className="stat-card-value">{slot.value}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
