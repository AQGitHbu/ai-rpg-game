"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { InlineButton, Panel, Tag } from "@ai-game/ui";
import type { GameSessionView } from "@/game/application";
import { AdventureGameShell } from "./AdventureGameShell";
import { NewGameSetupForm } from "./NewGameSetupForm";
import { fetchCurrentGame, ensureNarrative, retryNarrative, ackPrologue } from "./gameActionRequest";

// ---------------------------------------------------------------------------
// 根页面客户端协调器：直接消费 canonical API（/api/game/*）。
// 挂载时读取 GET /api/game/current。
//   none    → 显示创建表单
//   active  → 显示主游戏 Shell
//   结局后  → 只显示结局面板
//   corrupt → 错误提示
// ---------------------------------------------------------------------------

type ScreenState =
  | { phase: "loading" }
  | { phase: "none" }
  | { phase: "active"; view: GameSessionView }
  | { phase: "restart"; identity: string; expectedRevision: number }
  | { phase: "corrupt"; reason: string }
  | { phase: "unreachable" };

type RestartSetupMarker = {
  readonly identity: string;
  readonly expectedRevision: number;
};

const RESTART_SETUP_STORAGE_KEY = "ai-rpg-game:restart-setup";

function isRestartSetupMarker(value: unknown): value is RestartSetupMarker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.identity === "string"
    && candidate.identity.length > 0
    && candidate.identity.length <= 128
    && typeof candidate.expectedRevision === "number"
    && Number.isInteger(candidate.expectedRevision)
    && candidate.expectedRevision >= 0;
}

/**
 * The restart form is a browser-session intent, not a new server game state.
 * Storage access can be unavailable in privacy-restricted browsers, so these
 * helpers deliberately fall back to the authoritative ending response.
 */
function readRestartSetupMarker(): RestartSetupMarker | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(RESTART_SETUP_STORAGE_KEY);
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      window.sessionStorage.removeItem(RESTART_SETUP_STORAGE_KEY);
      return null;
    }
    if (!isRestartSetupMarker(parsed)) {
      window.sessionStorage.removeItem(RESTART_SETUP_STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeRestartSetupMarker(marker: RestartSetupMarker): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(RESTART_SETUP_STORAGE_KEY, JSON.stringify(marker));
  } catch {
    // The form remains usable for this render; a later refresh will safely
    // fall back to the ended save if browser storage is unavailable.
  }
}

function clearRestartSetupMarker(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(RESTART_SETUP_STORAGE_KEY);
  } catch {
    // Ignore storage restrictions; they must not block the current game UI.
  }
}

export function CurrentGameScreen() {
  const [state, setState] = useState<ScreenState>({ phase: "loading" });
  const prologueAckInFlight = useRef(false);
  const [prologueAcking, setPrologueAcking] = useState(false);
  const [prologueAckError, setPrologueAckError] = useState(false);
  const narrativeRetryInFlight = useRef(false);

  const applyResponse = useCallback((res: { ok: boolean; status: string; view?: GameSessionView; code?: string }) => {
    if (res.status === "none") {
      clearRestartSetupMarker();
      setState({ phase: "none" });
    } else if (res.status === "active" && res.view !== undefined) {
      const marker = readRestartSetupMarker();
      const ending = res.view.ending;
      const shouldRestoreRestart =
        ending !== null
        && marker !== null
        && marker.identity === ending.restartIdentity
        && marker.expectedRevision === res.view.revision;
      if (shouldRestoreRestart) {
        setState((current) => {
          // Keep the same monotonic revision guard as the active-game branch;
          // an older ended response must not reopen the setup over a newer UI.
          if (current.phase === "active" && current.view.revision > res.view!.revision) {
            return current;
          }
          return { phase: "restart", identity: marker!.identity, expectedRevision: marker!.expectedRevision };
        });
        return;
      }
      if (marker !== null) clearRestartSetupMarker();
      setState((current) => {
        // 多个 action/轮询请求可能交错返回；旧 revision 不能覆盖已经展示的
        // 新状态，否则战斗结束或结局写回后页面会短暂倒退到上一回合。
        if (current.phase === "active" && current.view.revision > res.view!.revision) {
          return current;
        }
        return { phase: "active", view: res.view! };
      });
    } else if (res.status === "corrupt") {
      setState({ phase: "corrupt", reason: res.code ?? "UNKNOWN" });
    } else {
      setState({ phase: "unreachable" });
    }
  }, []);

  const loadCurrentGame = useCallback(async () => {
    const res = await fetchCurrentGame();
    applyResponse(res);
  }, [applyResponse]);

  useEffect(() => {
    let cancelled = false;
    async function init() {
      const res = await fetchCurrentGame();
      if (!cancelled) applyResponse(res);
    }
    void init();
    return () => { cancelled = true; };
  }, [applyResponse]);

  // 任何持久化 pending 都立即触发幂等 ensure。首场景在黑屏序幕阅读期间
  // 静默生成；prologueShown 由仓储在并发场景写回中单调保留，不再靠延迟生成避竞态。
  const narrativePending = state.phase === "active" &&
    state.view.narrativeGeneration.status === "pending";

  useEffect(() => {
    if (!narrativePending) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    async function poll() {
      const outcome = await ensureNarrative();
      if (cancelled) return;
      if (!outcome.ok) {
        failures++;
      } else {
        failures = 0;
      }
      // Re-fetch current game
      const res = await fetchCurrentGame();
      if (!cancelled) applyResponse(res);
      if (!cancelled) {
        const delay = failures === 0 ? 750 : Math.min(5000, failures * 1000);
        timer = setTimeout(() => void poll(), delay);
      }
    }
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [narrativePending, applyResponse]);

  async function handleRetryNarrative(): Promise<void> {
    if (narrativeRetryInFlight.current) return;
    narrativeRetryInFlight.current = true;
    try {
      await retryNarrative();
      await loadCurrentGame();
    } finally {
      narrativeRetryInFlight.current = false;
    }
  }

  // 清除本地试玩存档
  async function clearDevelopmentSave() {
    const response = await fetch("/api/game/dev/current", { method: "DELETE" });
    if (!response.ok) throw new Error("CLEAR_DEVELOPMENT_SAVE_FAILED");
    await loadCurrentGame();
  }

  // 序幕确认
  async function handlePrologueAck() {
    if (prologueAckInFlight.current) return;
    prologueAckInFlight.current = true;
    setPrologueAcking(true);
    setPrologueAckError(false);
    try {
      if (await ackPrologue()) {
        await loadCurrentGame();
      } else {
        setPrologueAckError(true);
      }
    } catch {
      setPrologueAckError(true);
    } finally {
      prologueAckInFlight.current = false;
      setPrologueAcking(false);
    }
  }

  // 创建游戏后
  function handleCreated() {
    clearRestartSetupMarker();
    void loadCurrentGame();
  }

  if (state.phase === "loading") {
    return (
      <p role="status" aria-live="polite" className="form-status">
        正在读取当前存档……
      </p>
    );
  }

  if (state.phase === "active") {
    const { view } = state;
    if (view.narrativeGeneration.status === "failed") {
      return (
        <AdventureGameShell
          view={view}
          onViewChange={(newView) => applyResponse({ ok: true, status: "active", view: newView })}
          onStaleRevision={() => void loadCurrentGame()}
          onClearDevelopmentSave={clearDevelopmentSave}
          onRetryNarrative={handleRetryNarrative}
        />
      );
    }
    // 序幕只展示服务端生成并审批通过的 prologueText；空值不能用玩家输入
    // 冒充 AI 生成结果。
    if (!view.prologueShown) {
      const prologueText = view.prologueText;
      return (
        <Panel className="prologue-screen">
          <div className="prologue-content">
            <h2>序幕</h2>
            <p className="prologue-text">{prologueText || "开场叙事暂不可用，请重试。"}</p>
            {prologueAckError ? <p role="alert">进入失败，请检查连接后重试。</p> : null}
            <InlineButton disabled={prologueAcking} onClick={() => void handlePrologueAck()}>
              {prologueAcking ? "正在进入……" : "开始冒险"}
            </InlineButton>
          </div>
        </Panel>
      );
    }

    // 结局
    const ending = view.ending;
    if (ending !== null) {
      return (
        <section className="ending-stage" aria-label="冒险结局">
          <Panel className="ending-screen">
            <Tag variant={ending.outcome === "success" ? "success" : "danger"}>
              {ending.outcome === "success" ? "胜利" : "失败"}
            </Tag>
            <h2>{ending.name}</h2>
            <p>{ending.description || "你的冒险至此结束。"}</p>
            <InlineButton onClick={() => {
              const restart = {
                identity: ending.restartIdentity,
                expectedRevision: view.revision,
              };
              writeRestartSetupMarker(restart);
              setState({ phase: "restart", ...restart });
            }}>重新开始</InlineButton>
          </Panel>
        </section>
      );
    }

    return (
      <AdventureGameShell
        view={view}
        onViewChange={(newView) => setState((current) => {
          if (current.phase === "active" && current.view.revision > newView.revision) {
            return current;
          }
          return { phase: "active", view: newView };
        })}
        onStaleRevision={() => void loadCurrentGame()}
        onClearDevelopmentSave={clearDevelopmentSave}
        onRetryNarrative={handleRetryNarrative}
      />
    );
  }

  if (state.phase === "none") {
    return <NewGameSetupForm onCreated={handleCreated} />;
  }

  if (state.phase === "restart") {
    return <NewGameSetupForm
      onCreated={handleCreated}
      restart={{ identity: state.identity, expectedRevision: state.expectedRevision }}
    />;
  }

  if (state.phase === "corrupt") {
    return (
      <Panel className="error-panel">
        <Tag variant="danger">存档异常</Tag>
        <p role="alert">存档读取异常：{state.reason}</p>
        <InlineButton onClick={() => void loadCurrentGame()}>重试</InlineButton>
      </Panel>
    );
  }

  return (
    <Panel className="error-panel">
      <Tag variant="warning">读取失败</Tag>
      <p role="alert">未能读取存档，请刷新页面重试。</p>
      <InlineButton onClick={() => void loadCurrentGame()}>重试</InlineButton>
    </Panel>
  );
}
