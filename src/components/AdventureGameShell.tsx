"use client";

import { useRef, useState } from "react";
import type { GameSessionView } from "@/game/application";
import { InlineButton, Panel } from "@ai-game/ui";
import { postGameAction } from "./gameActionRequest";
import { AdventureHud, type DetailsPanel } from "./AdventureHud";
import { AdventureOverlay } from "./AdventureOverlay";
import { AdventureDetailsPanel } from "./AdventureDetailsPanel";
import { WorldMapScreen } from "./WorldMapScreen";
import { LocationSceneScreen } from "./LocationSceneScreen";
import { NpcDialoguePanel } from "./NpcDialoguePanel";
import { NarrativeScenePanel } from "./NarrativeScenePanel";
import { ToastContainer, type ToastMessage } from "./ToastNotification";

type AdventureGameShellProps = {
  readonly view: GameSessionView;
  readonly busy: boolean;
  readonly onBusyChange: (busy: boolean) => void;
  readonly onViewChange: (view: GameSessionView) => void;
  readonly onStaleRevision: () => void;
  readonly developmentTools: boolean;
  readonly onClearDevelopmentSave: () => Promise<void>;
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

const DETAIL_TITLE: Record<DetailsPanel, string> = {
  character: "角色",
  inventory: "背包",
  quests: "任务",
  journal: "日志"
};

export function AdventureGameShell({
  view,
  busy,
  onBusyChange,
  onViewChange,
  onStaleRevision,
  developmentTools,
  onClearDevelopmentSave
}: AdventureGameShellProps) {
  const [screen, setScreen] = useState<AdventureScreen>("map");
  const [detailsPanel, setDetailsPanel] = useState<DetailsPanel | null>(null);
  const [feedback, setFeedback] = useState<ActionFeedback>({ phase: "idle" });
  const [toasts, setToasts] = useState<readonly ToastMessage[]>([]);
  const toastSequenceRef = useRef(0);

  function pushToast(message: string): void {
    toastSequenceRef.current += 1;
    const toast: ToastMessage = {
      id: `toast-${toastSequenceRef.current}`,
      message,
      createdAt: Date.now()
    };
    setToasts((prev) => [...prev, toast]);
  }

  function dismissToast(id: string): void {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }
  // Older persisted/API test views predate the explicit generation field.
  // Treat their absence as ready so a compatible client can still render them.
  const narrativePending = view.narrativeGeneration?.status === "pending";
  const [dialogueNpcId, setDialogueNpcId] = useState<string | null>(null);
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const devToolsTriggerRef = useRef<HTMLElement | null>(null);

  const isSubmitting = feedback.phase === "submitting";
  const shellBusy = busy || isSubmitting;

  const activeDialogue = dialogueNpcId !== null
    ? view.dialogues.find((d) => d.npcId === dialogueNpcId) ?? null
    : null;

  function openDetails(panel: DetailsPanel): void {
    triggerRef.current = document.activeElement as HTMLElement;
    setDetailsPanel(panel);
  }

  function closeOverlay(): void {
    setDetailsPanel(null);
    setDialogueNpcId(null);
  }

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
        pushToast(outcome.message);
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
        pushToast(outcome.message);
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
        pushToast(outcome.message);
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

  async function handleNarrativeChoice(choiceToken: string): Promise<void> {
    setFeedback({ phase: "submitting" }); onBusyChange(true);
    const outcome = await postGameAction({ intent: { type: "narrative_choice", choiceToken }, revision: view.revision });
    onBusyChange(false);
    if (outcome.kind === "success") { setFeedback({ phase: "idle" }); pushToast(outcome.message); onViewChange(outcome.view); return; }
    if (outcome.kind === "rejected") { setFeedback({ phase: "rejected", message: outcome.message }); return; }
    if (outcome.kind === "stale") { setFeedback({ phase: "idle" }); onStaleRevision(); return; }
    setFeedback({ phase: "error", message: outcome.message });
  }

  return (
    <div className="adventure-game-shell">
      <AdventureHud
        view={view}
        screen={screen}
        onOpen={openDetails}
        developmentTools={developmentTools}
        onOpenDevTools={() => {
          devToolsTriggerRef.current = document.activeElement as HTMLElement;
          setDevToolsOpen(true);
        }}
      />

      {screen === "map" ? (
        <WorldMapScreen
          view={view}
          busy={shellBusy}
          onEnterCurrent={() => setScreen("scene")}
          onMove={(locationId) => void handleMove(locationId)}
        />
      ) : narrativePending && view.battle === null && view.ending === null ? (
        <Panel className="narrative-scene-panel narrative-pending-panel" aria-label="正在生成剧情">
          <p role="status" aria-live="polite">正在编排下一幕…</p>
          <p>世界导演、编剧与当前角色正在依据已保存的规则结果准备场景。</p>
        </Panel>
      ) : view.narrative !== null && view.battle === null && view.ending === null ? (
        <NarrativeScenePanel
          scene={view.narrative}
          busy={shellBusy}
          onChoose={(token) => void handleNarrativeChoice(token)}
          onReturnMap={() => setScreen("map")}
        />
      ) : (
        <LocationSceneScreen
          view={view}
          busy={shellBusy}
          onAction={(action) => void handleSceneAction(action)}
          onOpenDialogue={(npcId) => { triggerRef.current = document.activeElement as HTMLElement; setDialogueNpcId(npcId); }}
          onReturnMap={() => setScreen("map")}
        />
      )}

      {detailsPanel !== null ? (
        <AdventureOverlay title={DETAIL_TITLE[detailsPanel]} onClose={closeOverlay} returnFocusRef={triggerRef}>
          <AdventureDetailsPanel view={view} panel={detailsPanel} />
        </AdventureOverlay>
      ) : null}

      {activeDialogue !== null ? (
        <AdventureOverlay title={`与${activeDialogue.name}对话`} onClose={closeOverlay} returnFocusRef={triggerRef}>
          <NpcDialoguePanel
            dialogue={activeDialogue}
            gameType={view.world.gameType}
            busy={shellBusy}
            onChoice={(npcId, choiceId) => void handleDialogueChoice(npcId, choiceId)}
          />
        </AdventureOverlay>
      ) : null}

      {devToolsOpen ? (
        <AdventureOverlay title="开发工具" onClose={() => setDevToolsOpen(false)} returnFocusRef={devToolsTriggerRef}>
          <p className="development-tools-hint">
            仅清除当前本地试玩存档；不会删除数据库文件或其它项目数据。
          </p>
          <InlineButton onClick={() => void onClearDevelopmentSave()}>
            清除本地试玩存档
          </InlineButton>
        </AdventureOverlay>
      ) : null}

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

      {feedback.phase === "rejected" || feedback.phase === "error" ? (
        <p role="status" aria-live="polite" className={`action-feedback ${feedback.phase}`}>
          {feedback.message}
        </p>
      ) : null}

      {isSubmitting ? (
        <p role="status" aria-live="polite" className="action-feedback submitting">
          正在处理……
        </p>
      ) : null}
    </div>
  );
}
