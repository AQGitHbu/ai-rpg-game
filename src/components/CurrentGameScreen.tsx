"use client";

import { useEffect, useState } from "react";
import { Panel, Tag } from "@ai-game/ui";
import type { GameSessionView } from "@/game/application";
import { NewGameSetupForm } from "./NewGameSetupForm";
import { OpeningGameView } from "./OpeningGameView";
import { SceneActionPanel } from "./SceneActionPanel";
import { TravelPanel } from "./TravelPanel";
import { ItemPanel } from "./ItemPanel";
import { QuestTracker } from "./QuestTracker";
import { BattlePanel } from "./BattlePanel";
import { EndingPanel } from "./EndingPanel";

// ---------------------------------------------------------------------------
// 根页面客户端协调器（Phase 2–5 + Phase 6）：挂载时读取 GET /api/game/current。
//   none    → 显示创建表单；创建成功后无需刷新，直接切换到会话视图。
//   active  → 恢复已保存的会话视图：场景 + 行动面板 + 移动面板 + 物品面板 +
//             任务面板 + 战斗面板（如有）+ 结局面板（如有）；成功行动用 API
//             返回的最新 view 替换本地 view；任一面板提交中禁用全部行动按钮；
//             版本冲突后重新请求 current-game。
//   结局后  → 只显示结局面板与场景信息，普通互动区不再可操作。
//   corrupt → 按 reason 分支可恢复提示：真实数据损坏 ≠ 数据库暂时不可用。
// 只消费 API 响应与 application 的 read model 类型，不接触持久化/gameplay。
// ---------------------------------------------------------------------------

type ScreenState =
  | { phase: "loading" }
  | { phase: "none" }
  | { phase: "active"; view: GameSessionView }
  | { phase: "corrupt"; reason: string }
  | { phase: "unreachable" };

/** GET /api/game/current 的响应形态（宽松解析：非法 body 按不可达处理）。 */
type CurrentGameApiBody = {
  status?: string;
  view?: GameSessionView;
  reason?: string;
};

/** 数据损坏 reason → 可显示的具体原因（区别于基础设施失败）。 */
const CORRUPT_REASON_COPY: Record<string, string> = {
  UNPARSEABLE_RECORD: "存档记录无法解析",
  VERSION_MISMATCH: "存档版本与当前程序不匹配",
  GENERATION_MISMATCH: "存档内容与其生成记录不一致"
};

export function CurrentGameScreen() {
  const [state, setState] = useState<ScreenState>({ phase: "loading" });
  // 任一面板提交中：场景与移动面板的全部按钮一律禁用，避免并发写入。
  const [actionBusy, setActionBusy] = useState(false);

  async function loadCurrentGame(): Promise<void> {
    try {
      const response = await fetch("/api/game/current");
      const body = (await response.json().catch(() => null)) as CurrentGameApiBody | null;
      if (body?.status === "none") {
        setState({ phase: "none" });
      } else if (body?.status === "active" && body.view !== undefined) {
        setState({ phase: "active", view: body.view });
      } else if (body?.status === "corrupt" && typeof body.reason === "string") {
        setState({ phase: "corrupt", reason: body.reason });
      } else {
        setState({ phase: "unreachable" });
      }
    } catch {
      setState({ phase: "unreachable" });
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        const response = await fetch("/api/game/current");
        const body = (await response.json().catch(() => null)) as CurrentGameApiBody | null;
        if (cancelled) return;
        if (body?.status === "none") {
          setState({ phase: "none" });
        } else if (body?.status === "active" && body.view !== undefined) {
          setState({ phase: "active", view: body.view });
        } else if (body?.status === "corrupt" && typeof body.reason === "string") {
          setState({ phase: "corrupt", reason: body.reason });
        } else {
          setState({ phase: "unreachable" });
        }
      } catch {
        if (!cancelled) setState({ phase: "unreachable" });
      }
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.phase === "loading") {
    return (
      <p role="status" aria-live="polite" className="form-status">
        正在读取当前存档……
      </p>
    );
  }

  if (state.phase === "active") {
    const hasEnding = state.view.ending !== null;

    return (
      <div className="game-screen">
        <OpeningGameView view={state.view} />
        {hasEnding ? (
          <EndingPanel view={state.view} />
        ) : (
          <>
            <SceneActionPanel
              view={state.view}
              busy={actionBusy}
              onBusyChange={setActionBusy}
              onActionSuccess={(view) => setState({ phase: "active", view })}
              onStaleRevision={() => void loadCurrentGame()}
            />
            <TravelPanel
              view={state.view}
              busy={actionBusy}
              onBusyChange={setActionBusy}
              onActionSuccess={(view) => setState({ phase: "active", view })}
              onStaleRevision={() => void loadCurrentGame()}
            />
            <ItemPanel
              view={state.view}
              busy={actionBusy}
              onBusyChange={setActionBusy}
              onActionSuccess={(view) => setState({ phase: "active", view })}
              onStaleRevision={() => void loadCurrentGame()}
            />
            <BattlePanel
              view={state.view}
              busy={actionBusy}
              onBusyChange={setActionBusy}
              onActionSuccess={(view) => setState({ phase: "active", view })}
              onStaleRevision={() => void loadCurrentGame()}
            />
            <QuestTracker quests={state.view.activeQuests} />
          </>
        )}
      </div>
    );
  }

  if (state.phase === "none") {
    return <NewGameSetupForm onCreated={(view) => setState({ phase: "active", view })} />;
  }

  if (state.phase === "corrupt") {
    if (state.reason === "INFRASTRUCTURE_FAILURE") {
      return (
        <Panel className="setup-result" compact>
          <Tag variant="warning">暂时无法读取</Tag>
          <p role="alert">
            本地存档数据库暂时不可用：存档并未丢失，请稍后刷新页面重试。
          </p>
        </Panel>
      );
    }
    const detail = CORRUPT_REASON_COPY[state.reason] ?? "存档记录出现未知异常";
    return (
      <Panel className="setup-result" compact>
        <Tag variant="danger">存档数据已损坏</Tag>
        <p role="alert">
          {detail}（原因代码：{state.reason}）。本阶段不会自动重置或覆盖该存档，
          恢复方案将在后续阶段提供。
        </p>
      </Panel>
    );
  }

  return (
    <Panel className="setup-result" compact>
      <Tag variant="warning">读取失败</Tag>
      <p role="alert">未能读取当前存档：网络或本地服务异常，请刷新页面重试。</p>
    </Panel>
  );
}
