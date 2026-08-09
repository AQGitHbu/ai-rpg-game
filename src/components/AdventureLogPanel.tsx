import { Panel, Tag } from "@ai-game/ui";
import type { CompatibilityGameSessionView } from "@/game/application";

/**
 * 无 AI MVP 的连续叙事层：只显示 application 已投影的结构化事件文本。
 * 它不读取 state/blueprint，也不根据按钮自行推断剧情结果。
 */
export function AdventureLogPanel({ events }: { readonly events: CompatibilityGameSessionView["storyEvents"] }) {
  return (
    <Panel
      eyebrow="冒险记录"
      header={(
        <div className="panel-heading">
          <h2>你经历的故事</h2>
          <Tag variant="info">确定性试玩</Tag>
        </div>
      )}
    >
      {events.length === 0 ? (
        <p className="action-hint">故事刚刚开始，选择一个行动推进它。</p>
      ) : (
        <ol className="adventure-log" aria-label="冒险记录">
          {events.map((event, index) => <li key={`${index}-${event.text}`}>{event.text}</li>)}
        </ol>
      )}
    </Panel>
  );
}
