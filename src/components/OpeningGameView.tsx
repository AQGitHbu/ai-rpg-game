import { Panel, Tag } from "@ai-game/ui";
import type { OpeningGameView as OpeningGameViewModel } from "@/game/application";

// ---------------------------------------------------------------------------
// 开场视图（Task 4）：纯展示组件，只消费 application 的 read model 类型。
// 不出现任何可执行交互——没有动作按钮、自由输入或战斗入口；
// 建议行动仅为文本列表，并明确提示交互将在下一阶段开放。
// ---------------------------------------------------------------------------

type OpeningGameViewProps = {
  view: OpeningGameViewModel;
};

export function OpeningGameView({ view }: OpeningGameViewProps) {
  return (
    <div className="opening-view">
      <Panel
        eyebrow="当前存档 / 世界"
        header={(
          <div className="panel-heading">
            <div>
              <h2>{view.world.name}</h2>
              <p>{view.world.summary}</p>
            </div>
            <Tag variant="success">开场已就绪</Tag>
          </div>
        )}
      >
        <dl className="opening-facts">
          <div>
            <dt>主角</dt>
            <dd>
              {view.player.name} · {view.player.identity}
            </dd>
          </div>
          <div>
            <dt>当前地点</dt>
            <dd>{view.currentLocation.name}</dd>
          </div>
        </dl>
        <p className="opening-description">{view.currentLocation.description}</p>
      </Panel>

      <Panel eyebrow="开场叙事" title="故事从这里开始">
        <p className="opening-narration">{view.openingNarration}</p>
      </Panel>

      <Panel eyebrow="此刻所知" title="在场人物与随身物品">
        <div className="opening-columns">
          <section>
            <h3>在场人物</h3>
            <ul>
              {view.visibleNpcs.map((npc) => (
                <li key={npc.name}>
                  {npc.name}（{npc.role}）
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3>随身物品</h3>
            <ul>
              {view.initialItems.map((item) => (
                <li key={item.name}>
                  {item.name}：{item.description}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </Panel>

      <Panel
        eyebrow="下一步"
        header={(
          <div className="panel-heading">
            <h2>可能的行动方向</h2>
            <Tag variant="info">交互将在下一阶段开放</Tag>
          </div>
        )}
      >
        <ul>
          {view.suggestedActions.map((action) => (
            <li key={action}>{action}</li>
          ))}
        </ul>
        <p className="opening-hint">
          以上仅为开场提供的行动灵感，本阶段不可执行，也不会改变任何游戏状态。
        </p>
      </Panel>
    </div>
  );
}
