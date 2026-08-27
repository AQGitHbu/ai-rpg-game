"use client";

import { useState, useEffect, useRef } from "react";
import type { NpcDialogueView, NewGameInput, RelationshipTier } from "@/game/application";
import type { PlayerInteraction } from "./gameActionRequest";
import { normalizeDisplayText } from "./displayText";
import { AdventureVisual } from "./adventureVisuals";

// 以下类型与 reducer 自 LocationSceneScreen.tsx:31-74 原样迁移（Task 5 删除其重复原件）。
export type Dialogue = NpcDialogueView;

export type DialogueUiState = {
  readonly npcId: string | null;
  readonly revision: number;
  readonly pendingPlayerResponse: string | null;
  readonly pendingChoiceToken: string | null;
  /**
   * 已提交对白仅用于本页等待态展示。pending read model 不保证保留 choices，
   * 因此不能由它重建已选回应、其它固定选项或给予道具选项。
   */
  readonly pendingDialogue: Dialogue | null;
};

export type DialogueUiAction =
  | { readonly kind: "set"; readonly npcId: string | null }
  | { readonly kind: "submit"; readonly playerResponse: string; readonly choiceToken: string | null; readonly dialogue: Dialogue }
  | { readonly kind: "clear_pending" }
  | { readonly kind: "sync_revision"; readonly revision: number; readonly close: boolean };

export type DialoguePhase = "choice" | "waiting";

export type SubmittedDialogue = {
  readonly revision: number;
  readonly turnNumber: number;
};

export function reduceDialogueUiState(state: DialogueUiState, action: DialogueUiAction): DialogueUiState {
  switch (action.kind) {
    case "set": return { ...state, npcId: action.npcId, pendingPlayerResponse: null, pendingChoiceToken: null, pendingDialogue: null };
    case "submit": return {
      ...state,
      pendingPlayerResponse: action.playerResponse,
      pendingChoiceToken: action.choiceToken,
      pendingDialogue: action.dialogue,
    };
    case "clear_pending": return { ...state, pendingPlayerResponse: null, pendingChoiceToken: null, pendingDialogue: null };
    case "sync_revision": return {
      revision: action.revision,
      npcId: action.close ? null : state.npcId,
      pendingPlayerResponse: action.close ? null : state.pendingPlayerResponse,
      pendingChoiceToken: action.close ? null : state.pendingChoiceToken,
      pendingDialogue: action.close ? null : state.pendingDialogue,
    };
  }
}

const RELATIONSHIP_TIER_LABEL: Record<RelationshipTier, string> = {
  hostile: "敌视",
  cold: "冷淡",
  neutral: "中立",
  friendly: "友善",
  trusted: "信任",
};

export type NpcDialogueOverlayProps = {
  readonly dialogue: NpcDialogueView;
  readonly gameType: NewGameInput["gameType"];
  readonly busy: boolean;
  readonly phase: DialoguePhase;
  readonly pendingPlayerResponse: string | null;
  readonly pendingChoiceToken: string | null;
  readonly resetInputNonce: number;
  readonly handoffAcknowledgement: NpcDialogueView["handoffAcknowledgement"] | null;
  readonly relationshipTier: RelationshipTier | null;
  readonly onSubmit: (interaction: PlayerInteraction, playerResponse: string) => void;
  readonly onAcknowledge?: () => void;
  readonly onClose: () => void;
};

export function NpcDialogueOverlay({
  dialogue,
  gameType,
  busy,
  phase,
  pendingPlayerResponse,
  pendingChoiceToken,
  resetInputNonce,
  handoffAcknowledgement,
  relationshipTier,
  onSubmit,
  onAcknowledge,
  onClose,
}: NpcDialogueOverlayProps) {
  const [text, setText] = useState("");
  const previousResetInputNonce = useRef(resetInputNonce);
  const boxRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (previousResetInputNonce.current === resetInputNonce) return;
    previousResetInputNonce.current = resetInputNonce;
    setText("");
  }, [resetInputNonce]);

  // spec §6：打开时焦点进入对话框（键盘翻页可用），关闭（卸载）后回到原触发元素。
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    boxRef.current?.focus();
    return () => previouslyFocused?.focus();
  }, []);

  const locked = busy || phase === "waiting";

  return (
    <div
      className="npc-dialogue-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`与${dialogue.name}对话`}
      aria-busy={phase === "waiting"}
    >
      {relationshipTier !== null ? (
        <div className="npc-dialogue-overlay-affinity" aria-label="好感度">
          ♥ {dialogue.name} · {RELATIONSHIP_TIER_LABEL[relationshipTier]}
        </div>
      ) : null}

      <div className="npc-dialogue-overlay-figure" aria-hidden="true">
        {/* 延续 AdventureVisual 程序化风格：题材变体图作底，名字首字头像叠加其上 */}
        <div className="npc-dialogue-overlay-figure-art">
          <AdventureVisual gameType={gameType} kind="npc" label="" decorative />
        </div>
        <div className="npc-dialogue-overlay-avatar">{dialogue.name.charAt(0)}</div>
      </div>

      {/* 选项面板：Task 4 实现 */}

      <section className="npc-dialogue-overlay-box" ref={boxRef} tabIndex={0}>
        <span className="npc-dialogue-overlay-name">{dialogue.name}</span>
        <button
          type="button"
          className="npc-dialogue-overlay-close"
          aria-label="关闭对话"
          onClick={onClose}
          disabled={locked}
        >
          ×
        </button>
        <p className="npc-dialogue-overlay-speech">
          {dialogue.speechPages.length > 0 ? normalizeDisplayText(dialogue.speechPages[0]) : "还没有开始对话。"}
        </p>
      </section>
    </div>
  );
}
