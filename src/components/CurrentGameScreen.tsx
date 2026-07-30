"use client";

import { useEffect, useState } from "react";
import { InlineButton, Panel, Tag } from "@ai-game/ui";
import type { GameSessionView } from "@/game/application";
import { NewGameSetupForm } from "./NewGameSetupForm";
import { AdventureGameShell } from "./AdventureGameShell";
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
  // createdWithFallback：仅在本次创建回调中置 true 的一次性降级标记；
  // 刷新恢复/行动成功/重新读取都会清除，不随存档持久化。
  | { phase: "active"; view: GameSessionView; createdWithFallback: boolean }
  | { phase: "corrupt"; reason: string }
  | { phase: "unreachable" };

/** GET /api/game/current 的响应形态（宽松解析：非法 body 按不可达处理）。 */
type CurrentGameApiBody = {
  status?: string;
  view?: GameSessionView;
  reason?: string;
  developmentTools?: boolean;
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
  const [developmentTools, setDevelopmentTools] = useState(false);

  function applyCurrentGameBody(body: CurrentGameApiBody | null): void {
    setDevelopmentTools(body?.developmentTools === true);
    if (body?.status === "none") {
      setState({ phase: "none" });
    } else if (body?.status === "active" && body.view !== undefined) {
      // GET current 不携带生成来源：刷新恢复永远不显示降级提示。
      setState({ phase: "active", view: body.view, createdWithFallback: false });
    } else if (body?.status === "corrupt" && typeof body.reason === "string") {
      setState({ phase: "corrupt", reason: body.reason });
    } else {
      setState({ phase: "unreachable" });
    }
  }

  async function loadCurrentGame(): Promise<void> {
    try {
      const response = await fetch("/api/game/current");
      const body = (await response.json().catch(() => null)) as CurrentGameApiBody | null;
      applyCurrentGameBody(body);
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
        applyCurrentGameBody(body);
      } catch {
        if (!cancelled) setState({ phase: "unreachable" });
      }
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, []);

  async function clearDevelopmentSave(): Promise<void> {
    if (!window.confirm("仅清除当前本地试玩存档并重新开局？此操作只在开发环境可用。")) return;
    setActionBusy(true);
    try {
      const response = await fetch("/api/game/dev/current", { method: "DELETE" });
      const body = (await response.json().catch(() => null)) as { status?: string } | null;
      if (response.ok && (body?.status === "cleared" || body?.status === "none")) {
        setState({ phase: "none" });
        return;
      }
      // 生产或服务异常都不清空当前 UI，避免前端伪造新开局。
      await loadCurrentGame();
    } finally {
      setActionBusy(false);
    }
  }

  const developmentControl = developmentTools ? (
    <Panel className="setup-result" compact>
      <Tag variant="warning">开发工具</Tag>
      <p>仅清除当前本地试玩存档；不会删除数据库文件或其它项目数据。</p>
      <InlineButton disabled={actionBusy} onClick={() => void clearDevelopmentSave()}>
        清除本地试玩存档
      </InlineButton>
    </Panel>
  ) : null;

  if (state.phase === "loading") {
    return (
      <p role="status" aria-live="polite" className="form-status">
        正在读取当前存档……
      </p>
    );
  }

  if (state.phase === "active") {
    const hasEnding = state.view.ending !== null;
    const hasBattle = state.view.battle !== null;

    return (
      <div className="game-screen">
        {state.createdWithFallback ? (
          <Panel className="setup-result" compact>
            <Tag variant="warning">稳定模板开局</Tag>
            <p role="status" aria-live="polite">
              已使用稳定模板完成开局，仍可完整游玩。
            </p>
          </Panel>
        ) : null}
        {hasEnding ? (
          <EndingPanel view={state.view} />
        ) : hasBattle ? (
          <BattlePanel
            view={state.view}
            busy={actionBusy}
            onBusyChange={setActionBusy}
            onActionSuccess={(view) => setState({ phase: "active", view, createdWithFallback: false })}
            onStaleRevision={() => void loadCurrentGame()}
          />
        ) : (
          <AdventureGameShell
            view={state.view}
            busy={actionBusy}
            onBusyChange={setActionBusy}
            onViewChange={(view) => setState({ phase: "active", view, createdWithFallback: false })}
            onStaleRevision={() => void loadCurrentGame()}
            developmentTools={developmentTools}
            onClearDevelopmentSave={() => void clearDevelopmentSave()}
          />
        )}
      </div>
    );
  }

  if (state.phase === "none") {
    return (
      <NewGameSetupForm
        onCreated={(view, generationSource) =>
          setState({
            phase: "active",
            view,
            createdWithFallback: generationSource === "fallback"
          })
        }
      />
    );
  }

  if (state.phase === "corrupt") {
    if (state.reason === "INFRASTRUCTURE_FAILURE") {
      return (
        <>
          <Panel className="setup-result" compact>
            <Tag variant="warning">暂时无法读取</Tag>
            <p role="alert">
              本地存档数据库暂时不可用：存档并未丢失，请稍后刷新页面重试。
            </p>
          </Panel>
          {developmentControl}
        </>
      );
    }
    const detail = CORRUPT_REASON_COPY[state.reason] ?? "存档记录出现未知异常";
    return (
      <>
        <Panel className="setup-result" compact>
          <Tag variant="danger">存档数据已损坏</Tag>
          <p role="alert">
            {detail}（原因代码：{state.reason}）。本阶段不会自动重置或覆盖该存档，
            恢复方案将在后续阶段提供。
          </p>
        </Panel>
        {developmentControl}
      </>
    );
  }

  return (
    <>
      <Panel className="setup-result" compact>
        <Tag variant="warning">读取失败</Tag>
        <p role="alert">未能读取当前存档：网络或本地服务异常，请刷新页面重试。</p>
      </Panel>
      {developmentControl}
    </>
  );
}
