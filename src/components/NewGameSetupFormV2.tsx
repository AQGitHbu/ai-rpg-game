"use client";

import { useState, type FormEvent } from "react";
import { InlineButton, Panel, Tag } from "@ai-game/ui";

// ---------------------------------------------------------------------------
// V2 创建游戏表单：比 V1 简单——只需要 gameType + gameLength。
// V2 世界生成由服务端 WorldGenerationSource 处理，不需要玩家输入角色名/背景。
// ---------------------------------------------------------------------------

const GAME_TYPES = [
  { id: "wuxia" as const, label: "武侠", description: "江湖恩怨，刀光剑影" },
  { id: "xianxia" as const, label: "仙侠", description: "修仙问道，天地辽阔" },
  { id: "alternative_history" as const, label: "架空历史", description: "假想世界，风云变幻" },
];

const GAME_LENGTHS = [
  { id: "short" as const, label: "短篇", description: "约 5-8 幕" },
  { id: "medium" as const, label: "中篇", description: "约 10-15 幕" },
  { id: "long" as const, label: "长篇", description: "约 20-30 幕" },
];

type Props = {
  onCreated?: () => void;
};

export function NewGameSetupFormV2({ onCreated }: Props = {}) {
  const [gameType, setGameType] = useState<string>("wuxia");
  const [gameLength, setGameLength] = useState<string>("short");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/v2/game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameType, gameLength }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; revision?: number; code?: string } | null;
      if (response.ok && body?.ok === true) {
        onCreated?.();
        return;
      }
      switch (body?.code) {
        case "ACTIVE_GAME_EXISTS":
          setError("已存在进行中的存档，请刷新页面。");
          break;
        case "GENERATION_FAILED":
          setError("世界生成失败，请重试。");
          break;
        default:
          setError("创建失败，请稍后重试。");
      }
    } catch {
      setError("网络异常，请检查连接后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Panel className="new-game-form">
      <h2>开始新冒险</h2>
      <form onSubmit={handleSubmit}>
        <fieldset>
          <legend>选择题材</legend>
          {GAME_TYPES.map((t) => (
            <label key={t.id} className={gameType === t.id ? "selected" : ""}>
              <input
                type="radio"
                name="gameType"
                value={t.id}
                checked={gameType === t.id}
                onChange={() => setGameType(t.id)}
              />
              <span className="label-text">
                <strong>{t.label}</strong>
                <small>{t.description}</small>
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset>
          <legend>选择篇幅</legend>
          {GAME_LENGTHS.map((l) => (
            <label key={l.id} className={gameLength === l.id ? "selected" : ""}>
              <input
                type="radio"
                name="gameLength"
                value={l.id}
                checked={gameLength === l.id}
                onChange={() => setGameLength(l.id)}
              />
              <span className="label-text">
                <strong>{l.label}</strong>
                <small>{l.description}</small>
              </span>
            </label>
          ))}
        </fieldset>

        {error ? <Tag variant="danger">{error}</Tag> : null}

        <InlineButton type="submit" disabled={submitting}>
          {submitting ? "正在生成世界……" : "开始冒险"}
        </InlineButton>
      </form>
    </Panel>
  );
}
