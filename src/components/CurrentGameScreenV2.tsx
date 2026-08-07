"use client";

import { useCallback, useEffect, useState } from "react";
import { InlineButton, Panel, Tag } from "@ai-game/ui";
import type { GameSessionViewV2 } from "@/game/application/gameSessionViewV2";
import { AdventureGameShellV2 } from "./AdventureGameShellV2";
import { NewGameSetupForm } from "./NewGameSetupForm";
import { fetchV2CurrentGame, ensureV2Narrative, ackV2Prologue } from "./gameActionRequestV2";

// ---------------------------------------------------------------------------
// V2 根页面客户端协调器：直接消费 V2 API（/api/v2/game/*）。
// 挂载时读取 GET /api/v2/game/current。
//   none    → 显示创建表单
//   active  → 显示 V2 主游戏 Shell
//   结局后  → 只显示结局面板
//   corrupt → 错误提示
// ---------------------------------------------------------------------------

type ScreenState =
  | { phase: "loading" }
  | { phase: "none" }
  | { phase: "active"; view: GameSessionViewV2 }
  | { phase: "corrupt"; reason: string }
  | { phase: "unreachable" };

export function CurrentGameScreenV2() {
  const [state, setState] = useState<ScreenState>({ phase: "loading" });

  const applyResponse = useCallback((res: { ok: boolean; status: string; view?: GameSessionViewV2; code?: string }) => {
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
    const res = await fetchV2CurrentGame();
    applyResponse(res);
  }, [applyResponse]);

  useEffect(() => {
    let cancelled = false;
    async function init() {
      const res = await fetchV2CurrentGame();
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
      const ok = await ensureV2Narrative();
      if (cancelled) return;
      if (!ok) {
        failures++;
        if (failures >= 3) return;
      } else {
        failures = 0;
      }
      // Re-fetch current game
      const res = await fetchV2CurrentGame();
      if (!cancelled) applyResponse(res);
      if (!cancelled) timer = setTimeout(() => void poll(), 750);
    }
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [narrativePending, applyResponse]);

  // 序幕确认
  async function handlePrologueAck() {
    await ackV2Prologue();
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
      <AdventureGameShellV2
        view={view}
        onViewChange={(newView) => setState({ phase: "active", view: newView })}
        onStaleRevision={() => void loadCurrentGame()}
      />
    );
  }

  if (state.phase === "none") {
    return <NewGameSetupForm apiPath="/api/v2/game" onCreatedV2={handleCreated} />;
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
