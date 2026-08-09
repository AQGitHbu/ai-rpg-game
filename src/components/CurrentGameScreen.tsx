"use client";

import { useCallback, useEffect, useState } from "react";
import { InlineButton, Panel, Tag } from "@ai-game/ui";
import type { GameSessionView } from "@/game/application";
import { AdventureGameShell } from "./AdventureGameShell";
import { NewGameSetupForm } from "./NewGameSetupForm";
import { fetchCurrentGame, ensureNarrative, ackPrologue } from "./gameActionRequest";

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
  | { phase: "corrupt"; reason: string }
  | { phase: "unreachable" };

export function CurrentGameScreen() {
  const [state, setState] = useState<ScreenState>({ phase: "loading" });

  const applyResponse = useCallback((res: { ok: boolean; status: string; view?: GameSessionView; code?: string }) => {
    if (res.status === "none") {
      setState({ phase: "none" });
    } else if (res.status === "active" && res.view !== undefined) {
      setState({ phase: "active", view: res.view });
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

  // 叙事 pending 时轮询 ensure + 重新读取
  const narrativePending = state.phase === "active" &&
    state.view.narrativeGeneration?.status === "pending";

  useEffect(() => {
    if (!narrativePending) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    async function poll() {
      const ok = await ensureNarrative();
      if (cancelled) return;
      if (!ok) {
        failures++;
        if (failures >= 3) return;
      } else {
        failures = 0;
      }
      // Re-fetch current game
      const res = await fetchCurrentGame();
      if (!cancelled) applyResponse(res);
      if (!cancelled) timer = setTimeout(() => void poll(), 750);
    }
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [narrativePending, applyResponse]);

  // 清除本地试玩存档
  async function clearDevelopmentSave() {
    if (!window.confirm("仅清除当前本地试玩存档并重新开局？此操作只在开发环境可用。")) return;
    try {
      await fetch("/api/game/dev/current", { method: "DELETE" });
    } catch {
      // ignore
    }
    await loadCurrentGame();
  }

  // 序幕确认
  async function handlePrologueAck() {
    await ackPrologue();
    await loadCurrentGame();
  }

  // 创建游戏后
  function handleCreated() {
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
    // 序幕
    if (!view.prologueShown) {
      return (
        <Panel className="prologue-screen">
          <h2>序幕</h2>
          <p>你踏上了冒险的旅途。前方是未知的世界，充满了机遇与危险。</p>
          <InlineButton onClick={() => void handlePrologueAck()}>开始冒险</InlineButton>
        </Panel>
      );
    }

    // 结局
    if (view.ending !== null) {
      return (
        <Panel className="ending-screen">
          <Tag variant={view.ending.outcome === "success" ? "success" : "danger"}>
            {view.ending.outcome === "success" ? "胜利" : "失败"}
          </Tag>
          <h2>故事结局</h2>
          <p>你的冒险至此结束。</p>
          <InlineButton onClick={() => void loadCurrentGame()}>重新开始</InlineButton>
        </Panel>
      );
    }

    return (
      <AdventureGameShell
        view={view}
        onViewChange={(newView) => setState({ phase: "active", view: newView })}
        onStaleRevision={() => void loadCurrentGame()}
        onClearDevelopmentSave={clearDevelopmentSave}
      />
    );
  }

  if (state.phase === "none") {
    return <NewGameSetupForm onCreated={handleCreated} />;
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
