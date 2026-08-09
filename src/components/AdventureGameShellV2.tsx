"use client";

import { useRef, useState } from "react";
import type { GameSessionViewV2 } from "@/game/application/gameSessionViewV2";
import type { GameSessionView } from "@/game/application";
import { adaptV2ToV1View } from "./viewAdapterV2";
import { postV2Action, postV2Dialogue, type V2ActionOutcome, type V2DialogueResult } from "./gameActionRequestV2";
import { AdventureHud, type DetailsPanel } from "./AdventureHud";
import { AdventureOverlay } from "./AdventureOverlay";
import { AdventureDetailsPanel } from "./AdventureDetailsPanel";
import { WorldMapScreen } from "./WorldMapScreen";
import { LocationSceneScreen } from "./LocationSceneScreen";
import { NpcDialoguePanel, type FreeInputResult } from "./NpcDialoguePanel";
import { TravelNarrationScreen } from "./TravelNarrationScreen";
import { ToastContainer, type ToastMessage } from "./ToastNotification";
import { NarrativeGenerationModal } from "./NarrativeGenerationModal";
import { InlineButton, Panel } from "@ai-game/ui";

// ---------------------------------------------------------------------------
// V2 主游戏 Shell：复用 V1 全部视觉组件，通过 adaptV2ToV1View 将 V2 view
// 转换为 V1 GameSessionView 兼容结构。API 调用走 V2 路由（/api/v2/game/*）。
// ---------------------------------------------------------------------------

type Props = {
  readonly view: GameSessionViewV2;
  readonly onViewChange: (view: GameSessionViewV2) => void;
  readonly onStaleRevision: () => void;
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
  journal: "日志",
};

function entryScreenFor(_view: GameSessionViewV2): AdventureScreen {
  return "scene";
}

export function AdventureGameShellV2({ view, onViewChange, onStaleRevision, onClearDevelopmentSave }: Props) {
  const v1View = adaptV2ToV1View(view);

  const [screen, setScreen] = useState<AdventureScreen>("map");
  const [detailsPanel, setDetailsPanel] = useState<DetailsPanel | null>(null);
  const [feedback, setFeedback] = useState<ActionFeedback>({ phase: "idle" });
  const [toasts, setToasts] = useState<readonly ToastMessage[]>([]);
  const toastSequenceRef = useRef(0);
  const [dialogueNpcId, setDialogueNpcId] = useState<string | null>(null);
  const [dismissedTravelNarration, setDismissedTravelNarration] = useState(false);
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const devToolsTriggerRef = useRef<HTMLElement | null>(null);

  function pushToast(message: string): void {
    toastSequenceRef.current += 1;
    const toast: ToastMessage = {
      id: `toast-${toastSequenceRef.current}`,
      message,
      // pushToast 是事件处理器内调用，Date.now() 仅在交互时求值（非 render 期间）。
      // eslint-disable-next-line
      createdAt: Date.now(),
    };
    setToasts((prev) => [...prev, toast]);
  }

  function dismissToast(id: string): void {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }

  const narrativePending = view.narrativeGeneration?.status === "pending";
  const isSubmitting = feedback.phase === "submitting";
  const shellBusy = isSubmitting || narrativePending;

  const selectedDialogue = dialogueNpcId !== null
    ? v1View.dialogues.find((d) => d.npcId === dialogueNpcId) ?? null
    : null;

  const narrativeEventKind = v1View.narrative?.eventKind;
  const isTravelEvent = narrativeEventKind === "travel";
  const isDialogueScreen = narrativeEventKind === undefined || narrativeEventKind === "dialogue";
  const activeDialogue = !isTravelEvent && isDialogueScreen ? selectedDialogue : null;
  const showGenerationModal = narrativePending && v1View.narrative === null && v1View.battle === null && v1View.ending === null;

  function openDetails(panel: DetailsPanel): void {
    triggerRef.current = document.activeElement as HTMLElement;
    setDetailsPanel(panel);
  }

  function closeOverlay(): void {
    setDetailsPanel(null);
    setDialogueNpcId(null);
  }

  function handleOutcome(outcome: V2ActionOutcome): void {
    switch (outcome.kind) {
      case "success":
        setFeedback({ phase: "idle" });
        pushToast(outcome.message);
        onViewChange(outcome.view);
        setScreen(entryScreenFor(outcome.view));
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

  async function handleMove(locationId: string): Promise<void> {
    setFeedback({ phase: "submitting" });
    const outcome = await postV2Action({
      interaction: { kind: "fixed_choice", choiceToken: `move:${locationId}` },
      revision: view.revision,
    });
    handleOutcome(outcome);
  }

  async function handleSceneAction(action: SceneAction): Promise<void> {
    setFeedback({ phase: "submitting" });
    const choiceToken =
      action.type === "observe" ? "explore"
      : action.type === "investigate" ? `investigate:${action.factId}`
      : action.type === "take_item" ? `take_item:${action.itemId}`
      : `attack:${action.enemyId}`;
    const outcome = await postV2Action({
      interaction: { kind: "fixed_choice", choiceToken },
      revision: view.revision,
    });
    handleOutcome(outcome);
  }

  async function handleNarrativeChoice(choiceToken: string): Promise<void> {
    setFeedback({ phase: "submitting" });
    const outcome = await postV2Action({
      interaction: { kind: "fixed_choice", choiceToken },
      revision: view.revision,
    });
    if (outcome.kind === "success") {
      setFeedback({ phase: "idle" });
      pushToast(outcome.message);
      onViewChange(outcome.view);
      if (!outcome.view.narrative.hasScene) {
        setDialogueNpcId(null);
      }
      return;
    }
    handleOutcome(outcome);
  }

  function handleDialogueChoiceFromPanel(choiceToken: string): void {
    void handleNarrativeChoice(choiceToken);
  }

  async function handleFreeDialogue(npcId: string, text: string): Promise<FreeInputResult> {
    setFeedback({ phase: "submitting" });
    try {
      const result = await postV2Dialogue(npcId, text, view.revision);
      if (result.kind === "chat") {
        setFeedback({ phase: "idle" });
        return { kind: "chat", npcSpeech: result.npcSpeech };
      }
      if (result.kind === "narrative_trigger") {
        setFeedback({ phase: "idle" });
        setDialogueNpcId(null);
        if (result.view !== undefined) {
          onViewChange(result.view);
        }
        return { kind: "narrative_trigger" };
      }
      setFeedback({ phase: "idle" });
      return { kind: "chat", npcSpeech: "（对方似乎没听清。）" };
    } catch {
      setFeedback({ phase: "idle" });
      return { kind: "chat", npcSpeech: "（对方似乎没听清。）" };
    }
  }

  return (
    <div className="adventure-game-shell">
      <AdventureHud
        view={v1View}
        screen={screen}
        onOpen={openDetails}
        developmentTools={true}
        onOpenDevTools={() => {
          devToolsTriggerRef.current = document.activeElement as HTMLElement;
          setDevToolsOpen(true);
        }}
      />

      {screen === "map" ? (
        <WorldMapScreen
          view={v1View}
          busy={shellBusy}
          onEnterCurrent={() => setScreen(entryScreenFor(view))}
          onMove={(locationId) => void handleMove(locationId)}
        />
      ) : (
        <LocationSceneScreen
          view={v1View}
          busy={shellBusy}
          onAction={(action) => void handleSceneAction(action)}
          onOpenDialogue={(npcId) => { triggerRef.current = document.activeElement as HTMLElement; setDialogueNpcId(npcId); }}
          onReturnMap={() => setScreen("map")}
        />
      )}

      {/* V2 叙事选项：当有场景但没有打开的对话面板时，直接在场景中渲染选项 */}
      {screen === "scene" && view.narrative.hasScene && view.narrative.choices && activeDialogue === null && !narrativePending ? (
        <nav className="scene-narrative-choices" aria-label="场景选项">
          {view.narrative.choices.map((choice) => (
            <button
              key={choice.choiceToken}
              type="button"
              disabled={shellBusy}
              onClick={() => void handleNarrativeChoice(choice.choiceToken)}
            >
              {choice.label}
            </button>
          ))}
        </nav>
      ) : null}

      {detailsPanel !== null ? (
        <AdventureOverlay title={DETAIL_TITLE[detailsPanel]} onClose={closeOverlay} returnFocusRef={triggerRef}>
          <AdventureDetailsPanel view={v1View} panel={detailsPanel} />
        </AdventureOverlay>
      ) : null}

      {activeDialogue !== null ? (
        <AdventureOverlay title={`与${activeDialogue.name}对话`} onClose={closeOverlay} returnFocusRef={triggerRef}>
          <NpcDialoguePanel
            dialogue={activeDialogue}
            gameType={view.gameType as never}
            busy={shellBusy}
            onChoice={handleDialogueChoiceFromPanel}
            onFreeInput={handleFreeDialogue}
            freeInputBusy={shellBusy}
          />
        </AdventureOverlay>
      ) : null}

      {isTravelEvent && v1View.narrative !== null && !dismissedTravelNarration ? (
        <TravelNarrationScreen
          narration={v1View.narrative.narration}
          onComplete={() => { setDialogueNpcId(null); setScreen("scene"); setDismissedTravelNarration(true); }}
        />
      ) : null}

      {devToolsOpen ? (
        <AdventureOverlay title="开发工具" onClose={() => setDevToolsOpen(false)} returnFocusRef={devToolsTriggerRef}>
          <InlineButton onClick={() => void onClearDevelopmentSave()}>
            清除本地试玩存档
          </InlineButton>
        </AdventureOverlay>
      ) : null}

      {showGenerationModal ? (
        <NarrativeGenerationModal
          totalApiCalls={view.narrativeGeneration?.totalApiCalls}
          unavailable={false}
        />
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
