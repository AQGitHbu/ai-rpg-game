"use client";

import { useEffect, useRef, useState } from "react";
import { InlineButton } from "@ai-game/ui";
import type { GameSessionView } from "@/game/application";
import { postAction, type ActionOutcome, type PlayerInteraction } from "./gameActionRequest";
import { AdventureHud, type DetailsPanel } from "./AdventureHud";
import { AdventureOverlay } from "./AdventureOverlay";
import { AdventureDetailsPanel } from "./AdventureDetailsPanel";
import { WorldMapScreen } from "./WorldMapScreen";
import { LocationSceneScreen } from "./LocationSceneScreen";
import { TownLayerScreen } from "./TownLayerScreen";

type Props = {
  readonly view: GameSessionView;
  readonly onViewChange: (view: GameSessionView) => void;
  readonly onStaleRevision: () => void;
  readonly onClearDevelopmentSave: () => Promise<void>;
};

type AdventureScreen = "map" | "town" | "scene";

type ActionFeedback =
  | { readonly phase: "idle" }
  | { readonly phase: "submitting" }
  | { readonly phase: "success"; readonly message: string }
  | { readonly phase: "rejected"; readonly message: string }
  | { readonly phase: "error"; readonly message: string };

const DETAIL_TITLE: Record<DetailsPanel, string> = {
  character: "角色",
  inventory: "背包",
  quests: "任务",
  journal: "日志",
};

export function AdventureGameShell({
  view,
  onViewChange,
  onStaleRevision,
  onClearDevelopmentSave,
}: Props) {
  const [screen, setScreen] = useState<AdventureScreen>("map");
  const [detailsPanel, setDetailsPanel] = useState<DetailsPanel | null>(null);
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  const [feedback, setFeedback] = useState<ActionFeedback>({ phase: "idle" });
  const [focusNpcId, setFocusNpcId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const devToolsTriggerRef = useRef<HTMLElement | null>(null);
  const previousLocationRef = useRef<string | null>(null);

  const pending = view.narrativeGeneration.status === "pending";
  const isSubmitting = feedback.phase === "submitting";
  const busy = isSubmitting || pending;

  // 三层导航：从地图进入当前地点——town 地点先进小镇层，scene 地点直达场景。
  function entryScreenFor(view: GameSessionView): AdventureScreen {
    return view.currentLocation.scale === "town" && view.currentLocation.town !== null ? "town" : "scene";
  }

  // 场景返回：来自小镇的场景回到小镇层；来自 scene 地点回到地图。
  function returnFromScene(): void {
    setFocusNpcId(null);
    setScreen(view.currentLocation.scale === "town" ? "town" : "map");
  }

  // 玩家移动到新地点后，自动进入对应层级视图。
  useEffect(() => {
    const currentName = view.currentLocation.name;
    const previousName = previousLocationRef.current;
    previousLocationRef.current = currentName;
    if (previousName !== null && previousName !== currentName) {
      setFocusNpcId(null);
      setScreen(entryScreenFor(view));
    }
  }, [view.currentLocation.name, view.revision]);

  function applyOutcome(outcome: ActionOutcome): void {
    switch (outcome.kind) {
      case "success":
        setFeedback({ phase: "success", message: outcome.message });
        onViewChange(outcome.view);
        break;
      case "stale":
        setFeedback({ phase: "idle" });
        onStaleRevision();
        break;
      case "rejected":
      case "error":
        setFeedback({ phase: outcome.kind, message: outcome.message });
        break;
    }
  }

  function submitInteraction(interaction: PlayerInteraction): void {
    setFeedback({ phase: "submitting" });
    void postAction({ interaction, revision: view.revision }).then(applyOutcome);
  }

  function openDetails(panel: DetailsPanel): void {
    triggerRef.current = document.activeElement as HTMLElement;
    setDetailsPanel(panel);
  }

  function closeOverlay(): void {
    setDetailsPanel(null);
    setDevToolsOpen(false);
  }

  return (
    <main className="adventure-game-shell">
      <AdventureHud
        view={view}
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
          view={view}
          busy={busy}
          onEnterCurrent={() => {
            setFocusNpcId(null);
            setScreen(entryScreenFor(view));
          }}
          onMove={(choiceToken) => submitInteraction({ kind: "fixed_choice", choiceToken })}
        />
      ) : screen === "town" && view.currentLocation.town !== null ? (
        <TownLayerScreen
          town={view.currentLocation.town}
          busy={busy}
          onEnterBuilding={(npcId) => {
            setFocusNpcId(npcId);
            setScreen("scene");
          }}
          onReturnMap={() => setScreen("map")}
        />
      ) : (
        <LocationSceneScreen
          view={view}
          busy={busy}
          onSubmit={submitInteraction}
          onReturnMap={returnFromScene}
          initialFocusNpcId={focusNpcId}
        />
      )}

      {detailsPanel !== null ? (
        <AdventureOverlay title={DETAIL_TITLE[detailsPanel]} onClose={closeOverlay} returnFocusRef={triggerRef}>
          <AdventureDetailsPanel view={view} panel={detailsPanel} />
        </AdventureOverlay>
      ) : null}

      {devToolsOpen ? (
        <AdventureOverlay title="开发工具" onClose={closeOverlay} returnFocusRef={devToolsTriggerRef}>
          <p className="development-tools-hint">
            仅清除当前本地试玩存档；不会删除数据库文件或其它项目数据。
          </p>
          <InlineButton onClick={() => void onClearDevelopmentSave()}>
            清除本地试玩存档
          </InlineButton>
        </AdventureOverlay>
      ) : null}

      {feedback.phase === "success" ? (
        <p className="adventure-toast" role="status" aria-live="polite">
          {feedback.message}
        </p>
      ) : null}

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
    </main>
  );
}
