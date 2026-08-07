"use client";

import { useCallback, useEffect, useState } from "react";
import { InlineButton, Panel, Tag } from "@ai-game/ui";
import type { GameSessionViewV2 } from "@/game/application/gameSessionViewV2";
import { postV2Action, ensureV2Narrative, postV2Dialogue, type V2ActionOutcome } from "./gameActionRequestV2";

// ---------------------------------------------------------------------------
// V2 原生主游戏 Shell：直接消费 GameSessionViewV2，不依赖 V1 GameSessionView。
// 渲染：叙事场景 + 选项 + NPC 按钮 + 移动按钮 + 背包 + 任务 + 战斗面板 + 结局。
// ---------------------------------------------------------------------------

type Props = {
  readonly view: GameSessionViewV2;
  readonly onViewChange: (view: GameSessionViewV2) => void;
  readonly onStaleRevision: () => void;
};

type Feedback = { phase: "idle" } | { phase: "submitting" } | { phase: "error"; message: string };

export function AdventureGameShellV2({ view, onViewChange, onStaleRevision }: Props) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>({ phase: "idle" });
  const [dialogueText, setDialogueText] = useState("");
  const [npcSpeech, setNpcSpeech] = useState<string | null>(null);

  const handleOutcome = useCallback((outcome: V2ActionOutcome) => {
    setBusy(false);
    switch (outcome.kind) {
      case "success":
        setFeedback({ phase: "idle" });
        setNpcSpeech(null);
        onViewChange(outcome.view);
        return;
      case "rejected":
        setFeedback({ phase: "error", message: outcome.message });
        return;
      case "stale":
        setFeedback({ phase: "idle" });
        onStaleRevision();
        return;
      case "error":
        setFeedback({ phase: "error", message: outcome.message });
    }
  }, [onViewChange, onStaleRevision]);

  const submitChoice = useCallback((choiceToken: string) => {
    if (busy) return;
    setBusy(true);
    setFeedback({ phase: "submitting" });
    void postV2Action({
      interaction: { kind: "fixed_choice", choiceToken },
      revision: view.revision,
    }).then(handleOutcome);
  }, [busy, view.revision, handleOutcome]);

  const submitAction = useCallback((actionKey: string) => {
    submitChoice(actionKey);
  }, [submitChoice]);

  // 叙事 pending 时轮询 ensure
  const narrativePending = view.narrativeGeneration?.status === "pending";
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
      // Re-fetch current game after ensure
      // The parent (CurrentGameScreenV2) handles re-fetching
      timer = setTimeout(() => void poll(), 750);
    }
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [narrativePending]);

  // NPC 自由对话
  async function handleDialogueSubmit(npcId: string) {
    if (!dialogueText.trim()) return;
    setBusy(true);
    setFeedback({ phase: "submitting" });
    const result = await postV2Dialogue(npcId, dialogueText, view.revision);
    setBusy(false);
    setFeedback({ phase: "idle" });
    setDialogueText("");
    if (result.kind === "chat") {
      setNpcSpeech(result.npcSpeech);
    } else if (result.kind === "narrative_trigger") {
      setNpcSpeech(null);
      // Parent will re-fetch due to pending state
    } else {
      setFeedback({ phase: "error", message: result.message });
    }
  }

  // 结局面板
  if (view.ending !== null) {
    return (
      <div className="game-screen">
        <Panel className="ending-panel">
          <Tag variant={view.ending.outcome === "success" ? "success" : "danger"}>
            {view.ending.outcome === "success" ? "胜利" : "失败"}
          </Tag>
          <h2>故事结局</h2>
          <p>结局 ID：{view.ending.endingId}</p>
        </Panel>
      </div>
    );
  }

  // 战斗面板
  if (view.battle !== null) {
    return (
      <div className="game-screen">
        <Panel className="battle-panel">
          <h2>战斗：{view.battle.enemyName}</h2>
          <div className="battle-stats">
            <span>玩家 HP：{view.battle.playerHp}</span>
            <span>{view.battle.enemyName} HP：{view.battle.enemyHp}</span>
            <span>回合：{view.battle.round}</span>
          </div>
          <div className="battle-actions">
            <InlineButton disabled={busy} onClick={() => submitAction("battle_action:attack")}>攻击</InlineButton>
            <InlineButton disabled={busy} onClick={() => submitAction("battle_action:guard")}>防御</InlineButton>
            <InlineButton disabled={busy} onClick={() => submitAction("battle_action:flee")}>逃跑</InlineButton>
          </div>
        </Panel>
        {feedback.phase === "error" ? (
          <p role="status" className="action-feedback error">{feedback.message}</p>
        ) : null}
      </div>
    );
  }

  // 主场景
  return (
    <div className="game-screen">
      {/* HUD */}
      <Panel className="hud-panel" compact>
        <div className="hud-row">
          <Tag variant="info">{view.player.name} · {view.player.identity}</Tag>
          <span>HP {view.player.hp} · 攻 {view.player.attack} · 防 {view.player.defense}</span>
          <span>第 {view.story.currentAct}/{view.story.targetActs} 幕 · 张力 {view.story.tension}</span>
        </div>
      </Panel>

      {/* 叙事场景 */}
      {view.narrative.hasScene && view.narrative.narration ? (
        <Panel className="scene-panel">
          <p className="scene-narration" role="status" aria-live="polite">
            {view.narrative.narration}
          </p>
          {view.narrative.npcLine ? (
            <blockquote className="npc-line">
              <strong>{view.narrative.npcLine.text}</strong>
            </blockquote>
          ) : null}
          {/* 选项 */}
          {view.narrative.choices && view.narrative.choices.length > 0 ? (
            <div className="scene-choices">
              {view.narrative.choices.map((choice) => (
                <InlineButton
                  key={choice.choiceToken}
                  disabled={busy}
                  onClick={() => submitChoice(choice.choiceToken)}
                >
                  {choice.label}
                </InlineButton>
              ))}
            </div>
          ) : null}
        </Panel>
      ) : narrativePending ? (
        <Panel className="scene-pending">
          <p role="status" aria-live="polite">正在生成叙事场景……</p>
        </Panel>
      ) : (
        <Panel className="scene-empty">
          <p>{view.currentLocation.description}</p>
        </Panel>
      )}

      {/* NPC 对话区 */}
      {view.availableNpcs.length > 0 ? (
        <Panel className="npc-panel" compact>
          <h3>在场人物</h3>
          <div className="npc-list">
            {view.availableNpcs.map((npc) => (
              <div key={String(npc.id)} className="npc-item">
                <InlineButton disabled={busy} onClick={() => submitAction(`talk:${String(npc.id)}`)}>
                  与{npc.name}交谈
                </InlineButton>
                {npc.met ? <Tag variant="success">已识</Tag> : <Tag variant="default">陌生</Tag>}
              </div>
            ))}
          </div>
          {/* 自由输入 */}
          <div className="dialogue-input">
            <input
              type="text"
              value={dialogueText}
              onChange={(e) => setDialogueText(e.target.value)}
              placeholder="对NPC说点什么……"
              disabled={busy}
              onKeyDown={(e) => {
                if (e.key === "Enter" && view.availableNpcs[0]) {
                  void handleDialogueSubmit(String(view.availableNpcs[0].id));
                }
              }}
            />
            <InlineButton
              disabled={busy || !dialogueText.trim()}
              onClick={() => view.availableNpcs[0] && void handleDialogueSubmit(String(view.availableNpcs[0].id))}
            >
              说话
            </InlineButton>
          </div>
          {npcSpeech ? (
            <blockquote className="npc-speech">{npcSpeech}</blockquote>
          ) : null}
        </Panel>
      ) : null}

      {/* 移动面板 */}
      {view.availableMoves.length > 0 ? (
        <Panel className="move-panel" compact>
          <h3>前往</h3>
          <div className="move-list">
            {view.availableMoves.map((move) => (
              <InlineButton
                key={String(move.locationId)}
                disabled={busy}
                onClick={() => submitAction(`move:${String(move.locationId)}`)}
              >
                {move.name}
              </InlineButton>
            ))}
          </div>
        </Panel>
      ) : null}

      {/* 背包 */}
      {view.inventory.length > 0 ? (
        <Panel className="inventory-panel" compact>
          <h3>背包</h3>
          <ul>
            {view.inventory.map((item) => (
              <li key={item.itemId}>{item.name}</li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {/* 任务 */}
      {view.quests.length > 0 ? (
        <Panel className="quest-panel" compact>
          <h3>任务</h3>
          <ul>
            {view.quests.map((q) => (
              <li key={q.id}>
                <Tag variant={q.kind === "main" ? "info" : "default"}>{q.kind}</Tag>
                {q.name} — {q.status}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {/* 反馈 */}
      {feedback.phase === "error" ? (
        <p role="status" className="action-feedback error">{feedback.message}</p>
      ) : null}
      {feedback.phase === "submitting" ? (
        <p role="status" className="action-feedback submitting">正在处理……</p>
      ) : null}
    </div>
  );
}
