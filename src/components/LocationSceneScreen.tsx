"use client";

import type { GameSessionView, SceneInteractionView } from "@/game/application";
import { AdventureVisual } from "./adventureVisuals";
import { SceneActionMenu } from "./SceneActionMenu";

type SceneAction =
  | { readonly type: "observe"; readonly locationId: string }
  | { readonly type: "investigate"; readonly factId: string }
  | { readonly type: "take_item"; readonly itemId: string }
  | { readonly type: "start_battle"; readonly enemyId: string };

type LocationSceneScreenProps = {
  readonly view: GameSessionView;
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

  return (
    <section className="location-viewport" aria-label={`地点场景：${scene.title}`}>
      <div className="location-backdrop" aria-hidden="true">
        <AdventureVisual gameType={gameType} kind={scene.backdrop} label="" decorative />
      </div>
      <h2 className="location-scene-title">{scene.title}</h2>
      <p className="location-scene-caption">{scene.description}</p>

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
