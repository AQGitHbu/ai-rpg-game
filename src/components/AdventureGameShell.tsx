"use client";

import { useState } from "react";
import { InlineButton } from "@ai-game/ui";
import type { GameSessionView } from "@/game/application";
import { postGameAction } from "./gameActionRequest";
import { WorldMapScreen } from "./WorldMapScreen";
import { LocationSceneScreen } from "./LocationSceneScreen";
import { NpcDialoguePanel } from "./NpcDialoguePanel";
import { AdventureDetailsPanel } from "./AdventureDetailsPanel";

type AdventureGameShellProps = {
  readonly view: GameSessionView;
  readonly busy: boolean;
  readonly onBusyChange: (busy: boolean) => void;
  readonly onViewChange: (view: GameSessionView) => void;
  readonly onStaleRevision: () => void;
};

type AdventureScreen = "map" | "scene";

type ActionFeedback =
  | { readonly phase: "idle" }
  | { readonly phase: "submitting" }
  | { readonly phase: "rejected"; readonly message: string }
  | { readonly phase: "error"; readonly message: string };

type SceneAction =
  | { readonly type: "observe"; readonly locationId: string }
  | { readonly type: "investigate"; readonly factId: string }
  | { readonly type: "take_item"; readonly itemId: string }
  | { readonly type: "start_battle"; readonly enemyId: string };

export function AdventureGameShell({
  view,
  busy,
  onBusyChange,
  onViewChange,
  onStaleRevision
}: AdventureGameShellProps) {
  const [screen, setScreen] = useState<AdventureScreen>("map");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [feedback, setFeedback] = useState<ActionFeedback>({ phase: "idle" });
  const [dialogueNpcId, setDialogueNpcId] = useState<string | null>(null);

  const isSubmitting = feedback.phase === "submitting";
  const shellBusy = busy || isSubmitting;

  const activeDialogue = dialogueNpcId !== null
    ? view.dialogues.find((d) => d.npcId === dialogueNpcId) ?? null
    : null;

  async function handleMove(locationId: string): Promise<void> {
    setFeedback({ phase: "submitting" });
    onBusyChange(true);

    const outcome = await postGameAction({
      intent: { type: "move", locationId },
      revision: view.revision
    });

    onBusyChange(false);
    switch (outcome.kind) {
      case "success":
        setFeedback({ phase: "idle" });
        onViewChange(outcome.view);
        setScreen("scene");
        return;
      case "rejected":
        setFeedback({ phase: "rejected", message: outcome.message });
        return;
      case "stale":
        setFeedback({ phase: "idle" });
        onStaleRevision();
        return;
      case "error":
        setFeedback({ phase: "error", message: outcome.message });
    }
  }

  async function handleSceneAction(action: SceneAction): Promise<void> {
    setFeedback({ phase: "submitting" });
    onBusyChange(true);

    const payload =
      action.type === "observe"
        ? { intent: { type: "observe" as const, locationId: action.locationId }, revision: view.revision }
        : action.type === "investigate"
          ? { intent: { type: "investigate" as const, factId: action.factId }, revision: view.revision }
          : action.type === "take_item"
            ? { intent: { type: "take_item" as const, itemId: action.itemId }, revision: view.revision }
            : { intent: { type: "start_battle" as const, enemyId: action.enemyId }, revision: view.revision };

    const outcome = await postGameAction(payload);

    onBusyChange(false);
    switch (outcome.kind) {
      case "success":
        setFeedback({ phase: "idle" });
        onViewChange(outcome.view);
        return;
      case "rejected":
        setFeedback({ phase: "rejected", message: outcome.message });
        return;
      case "stale":
        setFeedback({ phase: "idle" });
        onStaleRevision();
        return;
      case "error":
        setFeedback({ phase: "error", message: outcome.message });
    }
  }

  async function handleDialogueChoice(npcId: string, choiceId: string): Promise<void> {
    setFeedback({ phase: "submitting" });
    onBusyChange(true);

    const outcome = await postGameAction({
      intent: { type: "dialogue_choice", npcId, choiceId },
      revision: view.revision
    });

    onBusyChange(false);
    switch (outcome.kind) {
      case "success":
        setFeedback({ phase: "idle" });
        onViewChange(outcome.view);
        return;
      case "rejected":
        setFeedback({ phase: "rejected", message: outcome.message });
        return;
      case "stale":
        setFeedback({ phase: "idle" });
        setDialogueNpcId(null);
        onStaleRevision();
        return;
      case "error":
        setFeedback({ phase: "error", message: outcome.message });
    }
  }

  return (
    <div className="game-screen">
      {screen === "map" ? (
        <WorldMapScreen
          view={view}
          busy={shellBusy}
          onEnterCurrent={() => setScreen("scene")}
          onMove={(locationId) => void handleMove(locationId)}
        />
      ) : (
        <LocationSceneScreen
          view={view}
          busy={shellBusy}
          onAction={(action) => void handleSceneAction(action)}
          onOpenDialogue={(npcId) => setDialogueNpcId(npcId)}
          onReturnMap={() => setScreen("map")}
        />
      )}

      {activeDialogue !== null ? (
        <NpcDialoguePanel
          dialogue={activeDialogue}
          busy={shellBusy}
          onChoice={(npcId, choiceId) => void handleDialogueChoice(npcId, choiceId)}
          onClose={() => setDialogueNpcId(null)}
        />
      ) : null}

      {feedback.phase === "rejected" || feedback.phase === "error" ? (
        <p
          role="status"
          aria-live="polite"
          className={
            feedback.phase === "rejected" ? "action-feedback rejected" : "action-feedback error"
          }
        >
          {feedback.message}
        </p>
      ) : null}

      {isSubmitting ? (
        <p role="status" aria-live="polite" className="action-feedback submitting">
          正在处理……
        </p>
      ) : null}

      <InlineButton aria-expanded={detailsOpen} onClick={() => setDetailsOpen((open) => !open)}>
        冒险详情
      </InlineButton>
      {detailsOpen ? <AdventureDetailsPanel view={view} /> : null}
    </div>
  );
}
