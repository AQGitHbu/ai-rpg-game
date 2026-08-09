"use client";

import { useState, type FormEvent } from "react";
import type { GameSessionView, NewGameInput } from "@/game/application";
import type { PlayerInteraction } from "./gameActionRequest";
import { AdventureVisual } from "./adventureVisuals";

type LocationSceneScreenProps = {
  readonly view: GameSessionView;
  readonly busy: boolean;
  readonly onSubmit: (interaction: PlayerInteraction) => void;
  readonly onReturnMap: () => void;
};

type Dialogue = NonNullable<GameSessionView["narrative"]["npcDialogues"]>[number];

function NpcDialogueCard({
  dialogue,
  gameType,
  busy,
  onSubmit,
}: {
  readonly dialogue: Dialogue;
  readonly gameType: NewGameInput["gameType"];
  readonly busy: boolean;
  readonly onSubmit: (interaction: PlayerInteraction) => void;
}) {
  const [text, setText] = useState("");
  const [collapsed, setCollapsed] = useState(false);

  async function submitFreeText(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const normalized = text.trim();
    if (normalized === "") return;
    onSubmit({ kind: "free_text", text: normalized, targetNpcId: dialogue.npcId });
    setText("");
  }

  // 玩家可随时关闭当前对话面板（收起）；重新展开需经行动栏再次发起交谈。
  if (collapsed) return null;

  return (
    <section className="npc-dialogue-panel" aria-label={`与${dialogue.name}对话`}>
      <button type="button" className="npc-dialogue-close" aria-label="关闭对话" onClick={() => setCollapsed(true)}>
        ×
      </button>
      <div className="npc-dialogue-stage">
        <figure className="npc-dialogue-figure">
          <span aria-hidden="true" style={{ width: 72, height: 48, display: "block" }}>
            <AdventureVisual gameType={gameType} kind="npc" label="" decorative />
          </span>
          <h3>{dialogue.name}</h3>
          <span>{dialogue.role}</span>
        </figure>
        <div className="npc-dialogue-speech">
          {dialogue.speechPages.map((page, index) => (
            <p key={`${dialogue.npcId}-${index}`} className="npc-dialogue-speech-text">{page}</p>
          ))}
        </div>
      </div>

      <div className="npc-dialogue-choices" role="group" aria-label="对话选项">
        {dialogue.choices.map((choice) => (
          <button
            key={choice.choiceToken}
            type="button"
            disabled={busy}
            onClick={() => onSubmit({ kind: "fixed_choice", choiceToken: choice.choiceToken })}
          >
            {choice.label}
          </button>
        ))}
      </div>

      {dialogue.freeInputEnabled ? (
        <form className="npc-dialogue-input" onSubmit={(event) => void submitFreeText(event)}>
          <input
            aria-label="自定义回应"
            value={text}
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
            maxLength={240}
          />
          <button type="submit" disabled={busy || text.trim() === ""}>发送</button>
        </form>
      ) : null}
    </section>
  );
}

export function LocationSceneScreen({ view, busy, onSubmit, onReturnMap }: LocationSceneScreenProps) {
  const gameType = view.gameType as NewGameInput["gameType"];
  const pending = view.narrativeGeneration.status === "pending";

  function renderChoiceButton(choice: { choiceToken: string; label: string }) {
    return (
      <button
        key={choice.choiceToken}
        type="button"
        disabled={busy || pending}
        onClick={() => onSubmit({ kind: "fixed_choice", choiceToken: choice.choiceToken })}
      >
        {choice.label}
      </button>
    );
  }

  return (
    <section className="location-viewport" aria-label={`地点场景：${view.currentLocation.name}`}>
      <div className="location-backdrop" aria-hidden="true">
        <AdventureVisual gameType={gameType} kind="location_backdrop" label="" decorative />
      </div>

      {/* 地点行动（探索 / 交谈 / 挑战 / 休息） */}
      <nav className="scene-action-rail" aria-label="行动栏">
        {view.currentLocation.actions.map(renderChoiceButton)}
        <button type="button" onClick={onReturnMap}>返回地图</button>
      </nav>

      <div className="location-scene-content">
        <p className="location-scene-caption">{view.currentLocation.description}</p>

        {/* 小镇层级：展示居民/人物入口，交谈统一走正式回合选项 */}
        {view.currentLocation.scale === "town" && view.currentLocation.npcs.length > 0 ? (
          <section className="scene-town-residents" aria-label="小镇人物">
            <h3>小镇人物</h3>
            {view.currentLocation.npcs.map((npc) => (
              <button
                key={npc.talkChoice.choiceToken}
                type="button"
                disabled={busy || pending}
                onClick={() => onSubmit({ kind: "fixed_choice", choiceToken: npc.talkChoice.choiceToken })}
              >
                <strong>{npc.name}</strong>
                <span>{npc.role}</span>
              </button>
            ))}
          </section>
        ) : null}

        {pending ? (
          <p role="status" aria-live="polite" className="narrative-pending-caption">
            正在编排下一幕……
          </p>
        ) : null}

        {/* 叙事场景：无选项时不渲染空分组 */}
        {view.narrative.hasScene && view.narrative.narration ? (
          <section className="scene-narrative" aria-label="当前场景">
            <p>{view.narrative.narration}</p>
            {view.narrative.choices.length > 0 ? (
              <div role="group" aria-label="场景选项">
                {view.narrative.choices.map(renderChoiceButton)}
              </div>
            ) : null}
          </section>
        ) : null}

        {/* 可获取物品 */}
        {view.obtainableItems.length > 0 ? (
          <section className="scene-obtainable" aria-label="可获取物品">
            {view.obtainableItems.map((item) => (
              <button
                key={item.choice.choiceToken}
                type="button"
                disabled={busy || pending}
                onClick={() => onSubmit({ kind: "fixed_choice", choiceToken: item.choice.choiceToken })}
              >
                <span aria-hidden="true" style={{ width: 64, height: 42, display: "block" }}>
                  <AdventureVisual gameType={gameType} kind="item" label="" decorative />
                </span>
                {item.choice.label}
              </button>
            ))}
          </section>
        ) : null}

        {/* 战斗 */}
        {view.battle !== null ? (
          <section className="battle-viewport" aria-label={`战斗 · ${view.battle.enemyName}`}>
            <div className="battle-arena-backdrop" aria-hidden="true">
              <AdventureVisual gameType={gameType} kind="enemy" label="" decorative />
            </div>
            <div className="battle-hud">
              <strong>{view.battle.enemyName}</strong>
              <span>第 {view.battle.round} 回合</span>
            </div>
            <div className="battle-combatant battle-combatant--enemy">
              <div className="battle-combatant-visual" aria-hidden="true">
                <AdventureVisual gameType={gameType} kind="enemy" label="" decorative />
              </div>
              <h3>{view.battle.enemyName}</h3>
              <p>HP {view.battle.enemyHp}</p>
            </div>
            <div className="battle-combatant">
              <h3>{view.player.name}</h3>
              <p>HP {view.battle.playerHp}</p>
            </div>
            <div className="battle-action-rail" role="group" aria-label="战斗行动">
              {view.battle.controls.map(renderChoiceButton)}
            </div>
          </section>
        ) : null}

        {/* NPC 对话：叙事生成中不渲染，避免出现无选项的空对话面板 */}
        {!pending ? (view.narrative.npcDialogues ?? []).map((dialogue) => (
          <NpcDialogueCard
            key={dialogue.npcId}
            dialogue={dialogue}
            gameType={gameType}
            busy={busy || pending}
            onSubmit={onSubmit}
          />
        )) : null}
      </div>
    </section>
  );
}
