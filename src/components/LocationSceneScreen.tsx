"use client";

import { useState } from "react";
import type { CompatibilityGameSessionView, SceneInteractionView } from "@/game/application";
import { AdventureVisual } from "./adventureVisuals";
import { SceneActionMenu } from "./SceneActionMenu";
import { SceneNarrationBar } from "./SceneNarrationBar";

type SceneAction =
  | { readonly type: "observe"; readonly locationId: string }
  | { readonly type: "investigate"; readonly factId: string }
  | { readonly type: "take_item"; readonly itemId: string }
  | { readonly type: "start_battle"; readonly enemyId: string };

type LocationSceneScreenProps = {
  readonly view: CompatibilityGameSessionView;
  readonly onAction: (action: SceneAction) => void;
  readonly onOpenDialogue: (npcId: string) => void;
  readonly onReturnMap: () => void;
  readonly busy: boolean;
};

function interactionAction(interaction: SceneInteractionView): SceneAction {
  switch (interaction.kind) {
    case "observe":
      return { type: "observe", locationId: interaction.locationId };
    case "investigate":
      return { type: "investigate", factId: interaction.factId };
    case "take_item":
      return { type: "take_item", itemId: interaction.itemId };
    case "start_battle":
      return { type: "start_battle", enemyId: interaction.enemyId };
  }
}

export function LocationSceneScreen({
  view,
  onAction,
  onOpenDialogue,
  onReturnMap,
  busy
}: LocationSceneScreenProps) {
  const gameType = view.world.gameType;
  const scene = view.locationScene;
  const [dismissedNarration, setDismissedNarration] = useState(false);

  // 轻量事件旁白：observe/investigate/item 场景有 narration 时显示 SceneNarrationBar
  const narrationKind = view.narrative?.eventKind;
  const showNarrationBar = view.narrative !== null
    && narrationKind !== undefined
    && narrationKind !== "dialogue"
    && narrationKind !== "travel"
    && !dismissedNarration;

  return (
    <section className="location-viewport" aria-label={`地点场景：${scene.title}`}>
      <div className="location-backdrop" aria-hidden="true">
        <AdventureVisual gameType={gameType} kind={scene.backdrop} label="" decorative />
      </div>
      <p className="location-scene-caption">{scene.description}</p>

      {showNarrationBar ? (
        <SceneNarrationBar
          narration={view.narrative!.narration}
          onDismiss={() => setDismissedNarration(true)}
        />
      ) : null}

      <div className="scene-hotspot-layer" role="group" aria-label="场景互动">
        {scene.interactions.map((interaction) => (
          <button
            key={`${interaction.kind}-${
              interaction.kind === "observe"
                ? interaction.locationId
                : interaction.kind === "investigate"
                  ? interaction.factId
                  : interaction.kind === "take_item"
                    ? interaction.itemId
                    : interaction.enemyId
            }`}
            type="button"
            className={`scene-hotspot scene-slot-${interaction.slot}`}
            disabled={busy}
            onClick={() => onAction(interactionAction(interaction))}
          >
            <AdventureVisual
              gameType={gameType}
              kind={
                interaction.kind === "observe"
                  ? "fact"
                  : interaction.kind === "investigate"
                    ? "fact"
                    : interaction.kind === "take_item"
                      ? "item"
                      : "enemy"
              }
              label={interaction.label}
              decorative
            />
            {interaction.label}
          </button>
        ))}

        {view.dialogues.map((dialogue) => (
          <button
            key={dialogue.npcId}
            type="button"
            className={`scene-hotspot scene-slot-${dialogue.slot}`}
            disabled={busy}
            onClick={() => onOpenDialogue(dialogue.npcId)}
          >
            <AdventureVisual gameType={gameType} kind="npc" label={dialogue.name} decorative />
            {dialogue.name}，{dialogue.role}
          </button>
        ))}
      </div>

      <SceneActionMenu
        interactions={scene.interactions}
        dialogues={view.dialogues}
        onAction={onAction}
        onOpenDialogue={onOpenDialogue}
        onReturnMap={onReturnMap}
        busy={busy}
      />
    </section>
  );
}
