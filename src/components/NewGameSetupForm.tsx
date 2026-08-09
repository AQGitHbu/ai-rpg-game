"use client";

import { useState, type FormEvent } from "react";
import { InlineButton, Panel } from "@ai-game/ui";
import type { NewGameInput } from "@/game/application";

const GAME_TYPES = [
  ["wuxia", "武侠"],
  ["xianxia", "仙侠"],
  ["fantasy", "奇幻"],
  ["science_fiction", "科幻"],
  ["urban", "都市"],
  ["alternate_history", "历史架空"],
  ["post_apocalypse", "末日"],
] as const satisfies readonly (readonly [NewGameInput["gameType"], string])[];

const GAME_LENGTHS = [
  ["short", "短篇"],
  ["medium", "中篇"],
] as const satisfies readonly (readonly [NonNullable<NewGameInput["gameLength"]>, string])[];

export type NewGameSetupFormProps = {
  readonly onCreated: () => void;
  readonly restartRevision?: number;
};

export function NewGameSetupForm({ onCreated, restartRevision }: NewGameSetupFormProps) {
  const [gameType, setGameType] = useState<NewGameInput["gameType"]>("wuxia");
  const [gameLength, setGameLength] = useState<NonNullable<NewGameInput["gameLength"]>>("short");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gameType,
          gameLength,
          ...(restartRevision === undefined ? {} : { restart: { expectedRevision: restartRevision } }),
        }),
      });
      const body = await response.json().catch(() => null) as { readonly ok?: boolean; readonly code?: string } | null;
      if (!response.ok || body?.ok !== true) {
        setError(
          body?.code === "ACTIVE_GAME_EXISTS"
            ? "已有进行中的游戏。"
            : body?.code === "STALE_GAME_REVISION"
              ? "结局存档已变化，请刷新后重试。"
              : "创建游戏失败，原结局存档已保留，请稍后重试。",
        );
        return;
      }
      onCreated();
    } catch {
      setError("无法连接本地游戏服务。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Panel className="new-game-setup">
      <form onSubmit={(event) => void submit(event)}>
        <h1>开始新的冒险</h1>
        <label>
          游戏类型
          <select value={gameType} onChange={(event) => setGameType(event.target.value as NewGameInput["gameType"])}>
            {GAME_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>
          故事长度
          <select value={gameLength} onChange={(event) => setGameLength(event.target.value as NonNullable<NewGameInput["gameLength"]>)}>
            {GAME_LENGTHS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <InlineButton type="submit" disabled={submitting}>{submitting ? "正在生成世界…" : "进入世界"}</InlineButton>
        {error !== "" ? <p role="alert">{error}</p> : null}
      </form>
    </Panel>
  );
}
