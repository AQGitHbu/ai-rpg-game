"use client";

import type { SceneInteractionView, NpcDialogueView } from "@/game/application";

type SceneAction =
  | { readonly type: "observe"; readonly locationId: string }
  | { readonly type: "investigate"; readonly factId: string }
  | { readonly type: "take_item"; readonly itemId: string }
  | { readonly type: "start_battle"; readonly enemyId: string };

type SceneActionMenuProps = {
  readonly interactions: readonly SceneInteractionView[];
  readonly dialogues: readonly NpcDialogueView[];
  readonly onAction: (action: SceneAction) => void;
  readonly onOpenDialogue: (npcId: string) => void;
  readonly onReturnMap: () => void;
  readonly busy: boolean;
};

export function SceneActionMenu({
  interactions,
  dialogues,
  onAction,
  onOpenDialogue,
  onReturnMap,
  busy
}: SceneActionMenuProps) {
  const observe = interactions.find((i) => i.kind === "observe");
  const investigate = interactions.find((i) => i.kind === "investigate");
  const takeItem = interactions.find((i) => i.kind === "take_item");
  const startBattle = interactions.find((i) => i.kind === "start_battle");

  return (
    <nav className="scene-action-rail" aria-label="行动栏">
      {dialogues.length > 0 ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => onOpenDialogue(dialogues[0].npcId)}
        >
          人物
        </button>
      ) : null}
      {observe ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => onAction({ type: "observe", locationId: observe.locationId })}
        >
          观察
        </button>
      ) : null}
      {investigate ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => onAction({ type: "investigate", factId: investigate.factId })}
        >
          线索
        </button>
      ) : null}
      {takeItem ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => onAction({ type: "take_item", itemId: takeItem.itemId })}
        >
          物品
        </button>
      ) : null}
      {startBattle ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => onAction({ type: "start_battle", enemyId: startBattle.enemyId })}
        >
          战斗
        </button>
      ) : null}
      <button type="button" onClick={onReturnMap}>
        地图
      </button>
    </nav>
  );
}
