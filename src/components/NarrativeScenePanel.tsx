"use client";

import { InlineButton, Panel } from "@ai-game/ui";
import type React from "react";
import type { NarrativeSceneView } from "@/game/application";

export function NarrativeScenePanel(props: Readonly<{
  scene: Exclude<NarrativeSceneView, null>;
  busy: boolean;
  onChoose: (choiceToken: string) => void;
}>): React.JSX.Element {
  const { scene, busy, onChoose } = props;
  return <Panel className="narrative-scene-panel" aria-label="剧情场景">
    <p className="narrative-scene-text">{scene.narration}</p>
    {scene.npcLine !== null ? <p className="narrative-npc-line">{scene.npcLine.text}</p> : null}
    <div className="narrative-choice-list">
      {scene.choices.map((choice) => <InlineButton key={choice.choiceToken} disabled={busy} onClick={() => onChoose(choice.choiceToken)}>{choice.label}</InlineButton>)}
    </div>
  </Panel>;
}
