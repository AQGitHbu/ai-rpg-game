import { Panel, Tag } from "@ai-game/ui";
import type { ActiveQuestView } from "@/game/application";

// ---------------------------------------------------------------------------
// QuestTracker（Phase 4 Task 4）：active 任务面板，纯展示组件。
// 只消费 CompatibilityGameSessionView.activeQuests 允许的信息：locked/closed 任务由
// read model 过滤，这里不做任何推断。objective 按 completed/supported 三态
// 打标签；未支持的 objective 标注「后续阶段能力」并附说明，绝不渲染
// 按钮或其他假的可完成入口。
// ---------------------------------------------------------------------------

type QuestTrackerProps = {
  quests: readonly ActiveQuestView[];
};

export function QuestTracker({ quests }: QuestTrackerProps) {
  return (
    <Panel eyebrow="任务" title="进行中的任务">
      {quests.length === 0 ? (
        <p className="quest-hint">当前没有进行中的任务。</p>
      ) : (
        <ul className="quest-list">
          {quests.map((quest) => (
            <li key={quest.name} className="quest-item">
              <div className="quest-heading">
                <h3>{quest.name}</h3>
                <Tag variant={quest.kind === "main" ? "accent" : "muted"}>
                  {quest.kind === "main" ? "主线" : "支线"}
                </Tag>
              </div>
              <p className="quest-description">{quest.description}</p>
              <ul className="quest-objectives">
                {quest.objectives.map((objective, index) => (
                  <li key={index}>
                    <span>{objective.label}</span>
                    {objective.completed ? (
                      <Tag variant="success">已完成</Tag>
                    ) : objective.supported ? (
                      <Tag variant="info">进行中</Tag>
                    ) : (
                      <Tag variant="warning">后续阶段能力</Tag>
                    )}
                  </li>
                ))}
              </ul>
              {quest.objectives.some((objective) => !objective.supported) && (
                <p className="quest-hint">
                  标注「后续阶段能力」的目标需等后续版本开放对应玩法后才能推进。
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
