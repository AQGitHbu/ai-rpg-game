"use client";

import { useState, type FormEvent } from "react";
import { InlineButton, Panel, Tag } from "@ai-game/ui";
import type { GameSessionView, PlayerChoiceView } from "@/game/application";
import { postAction, type ActionOutcome } from "./gameActionRequest";

type Props = {
  readonly view: GameSessionView;
  readonly onViewChange: (view: GameSessionView) => void;
  readonly onStaleRevision: () => void;
  readonly onClearDevelopmentSave: () => Promise<void>;
};

type Dialogue = NonNullable<GameSessionView["narrative"]["npcDialogues"]>[number];

function NpcInteractionCard({
  dialogue,
  revision,
  busy,
  onOutcome,
}: {
  readonly dialogue: Dialogue;
  readonly revision: number;
  readonly busy: boolean;
  readonly onOutcome: (outcome: ActionOutcome) => void;
}) {
  const [text, setText] = useState("");

  async function submitFreeText(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const normalized = text.trim();
    if (normalized === "") return;
    onOutcome(await postAction({
      interaction: { kind: "free_text", text: normalized, targetNpcId: dialogue.npcId },
      revision,
    }));
    setText("");
  }

  return (
    <Panel className="npc-interaction-card">
      <h3>{dialogue.name} · {dialogue.role}</h3>
      {dialogue.speechPages.map((page, index) => <p key={`${dialogue.npcId}-${index}`}>{page}</p>)}
      <div role="group" aria-label={`${dialogue.name}的回应选项`}>
        {dialogue.choices.map((choice) => (
          <InlineButton
            key={choice.choiceToken}
            disabled={busy}
            onClick={() => void postAction({
              interaction: { kind: "fixed_choice", choiceToken: choice.choiceToken },
              revision,
            }).then(onOutcome)}
          >
            {choice.label}
          </InlineButton>
        ))}
      </div>
      {dialogue.freeInputEnabled ? (
        <form onSubmit={(event) => void submitFreeText(event)}>
          <label>
            自定义回应
            <input value={text} disabled={busy} onChange={(event) => setText(event.target.value)} maxLength={240} />
          </label>
          <InlineButton type="submit" disabled={busy || text.trim() === ""}>发送</InlineButton>
        </form>
      ) : null}
    </Panel>
  );
}

export function AdventureGameShell({ view, onViewChange, onStaleRevision, onClearDevelopmentSave }: Props) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  function applyOutcome(outcome: ActionOutcome): void {
    setBusy(false);
    switch (outcome.kind) {
      case "success":
        setMessage(outcome.message);
        onViewChange(outcome.view);
        break;
      case "stale":
        onStaleRevision();
        break;
      case "rejected":
      case "error":
        setMessage(outcome.message);
        break;
    }
  }

  function submitChoice(choiceToken: string): void {
    setBusy(true);
    void postAction({ interaction: { kind: "fixed_choice", choiceToken }, revision: view.revision }).then(applyOutcome);
  }

  const pending = view.narrativeGeneration.status === "pending";
  const disabled = busy || pending;

  function renderChoiceButton(playerChoice: PlayerChoiceView) {
    return (
      <InlineButton
        key={playerChoice.choiceToken}
        disabled={disabled}
        onClick={() => submitChoice(playerChoice.choiceToken)}
      >
        {playerChoice.label}
      </InlineButton>
    );
  }

  return (
    <main className="canonical-game-shell">
      <header>
        <h1>{view.currentLocation.name}</h1>
        <p>{view.currentLocation.description}</p>
        <Tag>{view.player.name} · HP {view.player.hp}</Tag>
        <InlineButton onClick={() => void onClearDevelopmentSave()}>开发：重新开局</InlineButton>
      </header>

      {pending ? <p role="status">正在生成下一幕……</p> : null}
      {message !== "" ? <p role="status">{message}</p> : null}

      <Panel>
        <h2>世界地图</h2>
        <div role="group" aria-label="可前往地点">
          {view.worldMap.locations.map((location) => location.travelChoice === null
            ? <span key={location.id}>{location.name}{location.current ? "（当前）" : ""}</span>
            : renderChoiceButton(location.travelChoice))}
        </div>
      </Panel>

      <Panel>
        <h2>地点行动</h2>
        <div role="group" aria-label="地点行动">
          {view.currentLocation.actions.map(renderChoiceButton)}
        </div>
      </Panel>

      {view.obtainableItems.length > 0 ? (
        <Panel>
          <h2>可获取物品</h2>
          <div role="group" aria-label="可获取物品">
            {view.obtainableItems.map((item) => renderChoiceButton(item.choice))}
          </div>
        </Panel>
      ) : null}

      {view.battle !== null ? (
        <Panel>
          <h2>战斗 · {view.battle.enemyName}</h2>
          <p>第 {view.battle.round} 回合 · 你 {view.battle.playerHp} HP · 敌人 {view.battle.enemyHp} HP</p>
          <div role="group" aria-label="战斗行动">
            {view.battle.controls.map(renderChoiceButton)}
          </div>
        </Panel>
      ) : null}

      {view.narrative.hasScene ? (
        <Panel>
          <h2>当前场景</h2>
          {view.narrative.narration ? <p>{view.narrative.narration}</p> : null}
          <div role="group" aria-label="场景选项">
            {view.narrative.choices.map(renderChoiceButton)}
          </div>
        </Panel>
      ) : null}

      {(view.narrative.npcDialogues ?? []).map((dialogue) => (
        <NpcInteractionCard
          key={dialogue.npcId}
          dialogue={dialogue}
          revision={view.revision}
          busy={disabled}
          onOutcome={applyOutcome}
        />
      ))}

      <Panel>
        <h2>任务</h2>
        {view.quests.map((quest) => (
          <section key={quest.id}>
            <h3>{quest.name} · {quest.status}</h3>
            <p>{quest.description}</p>
            <ul>{quest.objectives.map((objective) => (
              <li key={objective.label}>{objective.completed ? "✓" : "○"} {objective.label}</li>
            ))}</ul>
          </section>
        ))}
      </Panel>
    </main>
  );
}
