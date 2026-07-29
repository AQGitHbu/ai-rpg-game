"use client";

import { useState } from "react";
import type { NpcDialogueView } from "@/game/application";
import { AdventureVisual } from "./adventureVisuals";

type NpcDialoguePanelProps = {
  readonly dialogue: NpcDialogueView;
  readonly gameType: string;
  readonly onChoice: (npcId: string, choiceId: string) => void;
  readonly busy: boolean;
};

export function NpcDialoguePanel({ dialogue, gameType, onChoice, busy }: NpcDialoguePanelProps) {
  const [cluesExpanded, setCluesExpanded] = useState(false);

  return (
    <div className="npc-dialogue-panel">
      <div className="npc-dialogue-header">
        <AdventureVisual gameType={gameType} kind="npc" label={dialogue.name} decorative />
        <h3>{dialogue.name}</h3>
        <span>{dialogue.role}</span>
      </div>

      <p className="npc-dialogue-greeting">{dialogue.name}向你点了点头。</p>

      <div className="npc-dialogue-choices" role="group" aria-label="对话选项">
        {dialogue.choices.map((choice) => {
          if (choice.kind === "review_clue") {
            return (
              <button
                key="review_clue"
                type="button"
                onClick={() => setCluesExpanded((expanded) => !expanded)}
                aria-expanded={cluesExpanded}
              >
                {choice.label}
              </button>
            );
          }
          return (
            <button
              key={choice.choiceId}
              type="button"
              disabled={busy}
              onClick={() => onChoice(dialogue.npcId, choice.choiceId)}
            >
              {choice.label}
            </button>
          );
        })}
      </div>

      {cluesExpanded && dialogue.reviewClues.length > 0 ? (
        <ul className="npc-dialogue-clues" aria-label="已知线索">
          {dialogue.reviewClues.map((clue) => (
            <li key={clue}>{clue}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
