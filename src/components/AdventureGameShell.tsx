"use client";

import { useState, type FormEvent } from "react";
import { InlineButton, Panel, Tag } from "@ai-game/ui";
import type { GameSessionView } from "@/game/application";
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
      <h3>{dialogue.npcName} · {dialogue.npcRole}</h3>
      {dialogue.speechPages.map((page, index) => <p key={`${dialogue.npcId}-${index}`}>{page}</p>)}
      <div role="group" aria-label={`${dialogue.npcName}的回应选项`}>
        {(dialogue.choices ?? []).map((choice) => (
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

  const pending = view.narrativeGeneration?.status === "pending";
  const disabled = busy || pending;

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

      {view.narrative.hasScene ? (
        <Panel>
          <h2>当前场景</h2>
          {view.narrative.narration ? <p>{view.narrative.narration}</p> : null}
          <div role="group" aria-label="场景选项">
            {(view.narrative.choices ?? []).map((choice) => (
              <InlineButton key={choice.choiceToken} disabled={disabled} onClick={() => submitChoice(choice.choiceToken)}>
                {choice.label}
              </InlineButton>
            ))}
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
        {view.quests.map((quest) => <p key={quest.id}>{quest.name} · {quest.status}</p>)}
      </Panel>
    </main>
  );
}
