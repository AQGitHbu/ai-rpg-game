"use client";

import { useState } from "react";
import { InlineButton, Panel } from "@ai-game/ui";
import type { GameSessionView } from "@/game/application";
import { postGameAction } from "./gameActionRequest";
import { WorldMapScreen } from "./WorldMapScreen";

// ---------------------------------------------------------------------------
// AdventureGameShell（Phase 7 Task 5）：地图优先的导航状态机 + action 协议编排。
// 只维护三份本地 UI 状态：screen: map | scene（首次 active view 显示地图）、
// 次级信息面板开关（Task 6 填充内容）与移动反馈；持久化状态一律来自 view prop。
//   - 进入当前地点 / 返回地图 = 纯本地切换：零请求、不递增 revision；
//   - move 经 postGameAction 提交：success 上报最新 view 并自动切到 scene，
//     rejected 留在地图显示服务端反馈，stale 只触发 onStaleRevision（由父级
//     重新读取 current-game），error 显示稳定文案、绝不伪造移动成功。
// 地点场景本任务先渲染最小占位（标题 + 描述 + 返回地图）；完整热点与对话
// 由 Task 6 的 LocationSceneScreen 接管。
// ---------------------------------------------------------------------------

type AdventureGameShellProps = {
  readonly view: GameSessionView;
  readonly busy: boolean;
  readonly onBusyChange: (busy: boolean) => void;
  readonly onViewChange: (view: GameSessionView) => void;
  readonly onStaleRevision: () => void;
};

type AdventureScreen = "map" | "scene";

type MoveFeedback =
  | { readonly phase: "idle" }
  | { readonly phase: "submitting" }
  | { readonly phase: "rejected"; readonly message: string }
  | { readonly phase: "error"; readonly message: string };

export function AdventureGameShell({
  view,
  busy,
  onBusyChange,
  onViewChange,
  onStaleRevision
}: AdventureGameShellProps) {
  const [screen, setScreen] = useState<AdventureScreen>("map");
  // Task 6 的角色/背包/任务/日志次级面板挂在这个开关下；本任务只保留入口状态。
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [feedback, setFeedback] = useState<MoveFeedback>({ phase: "idle" });

  const isSubmitting = feedback.phase === "submitting";
  const shellBusy = busy || isSubmitting;

  async function handleMove(locationId: string): Promise<void> {
    setFeedback({ phase: "submitting" });
    onBusyChange(true);

    const outcome = await postGameAction({
      intent: { type: "move", locationId },
      revision: view.revision
    });

    onBusyChange(false);
    switch (outcome.kind) {
      case "success":
        // 移动成功：上报最新 view 并自动进入目标地点场景。
        setFeedback({ phase: "idle" });
        onViewChange(outcome.view);
        setScreen("scene");
        return;
      case "rejected":
        // 规则拒绝：留在地图，显示服务端稳定原因。
        setFeedback({ phase: "rejected", message: outcome.message });
        return;
      case "stale":
        // 版本冲突：只交给父级重新读取当前存档，不显示伪造结果。
        setFeedback({ phase: "idle" });
        onStaleRevision();
        return;
      case "error":
        // 其他错误：显示稳定文案，绝不伪造移动成功。
        setFeedback({ phase: "error", message: outcome.message });
    }
  }

  return (
    <div className="game-screen">
      {screen === "map" ? (
        <WorldMapScreen
          view={view}
          busy={shellBusy}
          onEnterCurrent={() => setScreen("scene")}
          onMove={(locationId) => void handleMove(locationId)}
        />
      ) : (
        // Task 5 的最小地点场景占位：Task 6 用 LocationSceneScreen 替换主体。
        <Panel eyebrow="地点场景" header={<h2>{view.locationScene.title}</h2>}>
          <p>{view.locationScene.description}</p>
          <InlineButton disabled={shellBusy} onClick={() => setScreen("map")}>
            返回地图
          </InlineButton>
        </Panel>
      )}

      {feedback.phase === "rejected" || feedback.phase === "error" ? (
        <p
          role="status"
          aria-live="polite"
          className={
            feedback.phase === "rejected" ? "action-feedback rejected" : "action-feedback error"
          }
        >
          {feedback.message}
        </p>
      ) : null}

      {isSubmitting ? (
        <p role="status" aria-live="polite" className="action-feedback submitting">
          正在赶路……
        </p>
      ) : null}

      <InlineButton aria-expanded={detailsOpen} onClick={() => setDetailsOpen((open) => !open)}>
        冒险详情
      </InlineButton>
      {detailsOpen ? (
        // Task 6 在此渲染 AdventureDetailsPanel（角色 / 背包 / 任务 / 日志）。
        <div className="adventure-details" aria-label="冒险详情面板" />
      ) : null}
    </div>
  );
}
