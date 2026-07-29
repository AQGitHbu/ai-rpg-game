"use client";

import { useState, useEffect, useCallback } from "react";
import { InlineButton } from "@ai-game/ui";
import type { NpcDialogueView } from "@/game/application";

type NpcDialoguePanelProps = {
  readonly dialogue: NpcDialogueView;
  readonly onChoice: (npcId: string, choiceId: string) => void;
  readonly onClose: () => void;
  readonly busy: boolean;
};

export function NpcDialoguePanel({ dialogue, onChoice, onClose, busy }: NpcDialoguePanelProps) {
  const [cluesExpanded, setCluesExpanded] = useState(false);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    },
    [onClose]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div role="dialog" aria-label={`与${dialogue.name}对话`} className="npc-dialogue-panel">
      <div className="npc-dialogue-header">
        <h3>{dialogue.name}</h3>
        <span>{dialogue.role}</span>
      </div>

      <div className="npc-dialogue-choices" role="group" aria-label="对话选项">
        {dialogue.choices.map((choice) => {
          if (choice.kind === "review_clue") {
            return (
              <InlineButton
                key="review_clue"
                onClick={() => setCluesExpanded((expanded) => !expanded)}
                aria-expanded={cluesExpanded}
              >
                {choice.label}
              </InlineButton>
            );
          }
          return (
            <InlineButton
              key={choice.choiceId}
              disabled={busy}
              onClick={() => onChoice(dialogue.npcId, choice.choiceId)}
            >
              {choice.label}
            </InlineButton>
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

      <InlineButton onClick={onClose}>关闭对话</InlineButton>
    </div>
  );
}
