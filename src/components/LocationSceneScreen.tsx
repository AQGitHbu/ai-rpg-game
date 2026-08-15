"use client";

import { useState, useEffect, useReducer, useRef, type FormEvent } from "react";
import { composeDirectNpcGreeting, type GameSessionView, type NewGameInput } from "@/game/application";
import type { PlayerInteraction } from "./gameActionRequest";
import { AdventureVisual } from "./adventureVisuals";
import { normalizeDisplayText } from "./displayText";

type LocationSceneScreenProps = {
  readonly view: GameSessionView;
  readonly busy: boolean;
  readonly onSubmit: (interaction: PlayerInteraction) => void;
  readonly onReturnMap: () => void;
  /** Task 7：从小镇建筑进入场景时聚焦该建筑绑定的 NPC（打开其对话）。 */
  readonly initialFocusNpcId?: string | null;
  /** 建筑场景中的唯一 NPC 名称，用于过滤地点层 NPC 投影。 */
  readonly sceneNpcName?: string | null;
  /** 建筑场景的展示名称，不改变权威 currentLocation。 */
  readonly sceneLocationName?: string | null;
  /** 城镇建筑场景的稳定建筑 ID，用于隔离该建筑内的地点物品。 */
  readonly sceneBuildingId?: string | null;
};

type Dialogue = NonNullable<GameSessionView["narrative"]["npcDialogues"]>[number];

type BattleFeedback = {
  readonly kind: "player-action" | "enemy-hit" | "player-hit" | "resolved";
  readonly message: string;
};

type DialogueUiState = {
  readonly npcId: string | null;
  readonly revision: number;
};

type DialogueUiAction =
  | { readonly kind: "set"; readonly npcId: string | null }
  | { readonly kind: "sync_revision"; readonly revision: number; readonly close: boolean };

type DialoguePhase = "choice" | "waiting" | "response";

type SubmittedDialogue = {
  readonly revision: number;
  readonly turnNumber: number;
  readonly objectiveLabel: string | null;
};

function reduceDialogueUiState(state: DialogueUiState, action: DialogueUiAction): DialogueUiState {
  switch (action.kind) {
    case "set": return { ...state, npcId: action.npcId };
    case "sync_revision": return {
      revision: action.revision,
      npcId: action.close ? null : state.npcId,
    };
  }
}

/**
 * 地点旁注只负责回答“我现在在哪里、这里发生了什么”。
 * 主线目标与任务完成提示由 HUD/任务面板承载，不能混进地点氛围段落。
 */
function cleanLocationSideNote(text: string): string {
  return text
    .replace(/主线推进(?:到第\d+幕)?[。！？!?]?/gu, "")
    .replace(/已完成：[^。！？!?]*[。！？!?]?/gu, "")
    .replace(/完成了任务「[^」]+」的目标：[^。！？!?]*[。！？!?]?/gu, "")
    .replace(/当前目标：[^。！？!?]*[。！？!?]?/gu, "")
    .replace(/。{2,}/gu, "。")
    .replace(/([。！？])\s+/gu, "$1")
    .replace(/\s+/gu, " ")
    .replace(/([。！？])\1+/gu, "$1")
    .replace(/^[。！？\s]+/gu, "")
    .trim();
}

/** 城镇建筑是独立的可游玩场景，不能把镇口/街道的公共说明搬进室内。 */
function describeBuildingScene(buildingType: string | undefined, buildingName: string, npcName: string | null | undefined): string {
  const npcClause = npcName ? `${npcName}就在近处，留意着你的来意。` : "屋内有人留意着门口的动静。";
  switch (buildingType) {
    case "tavern": return `${buildingName}里酒气、炭火和低声交谈混在一起，靠窗的木桌还留着湿漉漉的斗笠。${npcClause}`;
    case "blacksmith": return `${buildingName}的炉火映红铁砧，锤声一停，空气里只剩铁屑和焦炭的味道。${npcClause}`;
    case "guild": return `${buildingName}的告示板贴满旧纸条，来往的人压低嗓音交换消息。${npcClause}`;
    case "clinic": return `${buildingName}里药草微苦，帘后偶尔传来瓷碗相碰的轻响。${npcClause}`;
    case "market": return `${buildingName}外的叫卖声被门帘隔开，柜台上散着刚换手的货单。${npcClause}`;
    default: return `${buildingName}与镇上的街巷隔出一层安静，眼前的陈设暗示着这里惯常发生的营生。${npcClause}`;
  }
}

function BattleScene({
  view,
  battle,
  gameType,
  busy,
  pending,
  battleFeedback,
  onBattleFeedback,
  onSubmit,
}: {
  readonly view: GameSessionView;
  readonly battle: NonNullable<GameSessionView["battle"]>;
  readonly gameType: NewGameInput["gameType"];
  readonly busy: boolean;
  readonly pending: boolean;
  readonly battleFeedback: BattleFeedback | null;
  readonly onBattleFeedback: (message: string) => void;
  readonly onSubmit: (interaction: PlayerInteraction) => void;
}) {
  const enemyNames = battle.units === undefined
    ? [battle.enemyName]
    : battle.units
      .filter((unit) => unit.side === "enemies")
      .map((unit) => unit.name);
  const enemyLabel = enemyNames.length > 1 ? enemyNames.join("、") : battle.enemyName;

  function renderBattleChoiceButton(choice: { choiceToken: string | null; label: string; enabled?: boolean; disabledReason?: string | null }) {
    return (
      <button
        key={`${choice.label}:${choice.choiceToken ?? "disabled"}`}
        type="button"
        data-battle-action="true"
        disabled={busy || pending || choice.enabled === false || choice.choiceToken === null}
        onClick={() => {
          if (choice.choiceToken === null) return;
          onBattleFeedback(`你${choice.label}！`);
          onSubmit({ kind: "fixed_choice", choiceToken: choice.choiceToken });
        }}
      >
        {choice.label}{choice.disabledReason ? `（${choice.disabledReason}）` : ""}
      </button>
    );
  }

  return (
    <section className="battle-viewport battle-viewport--fullscreen" aria-label={`战斗 · ${enemyLabel}`}>
      <div className="battle-arena-backdrop" aria-hidden="true">
        <AdventureVisual gameType={gameType} kind="enemy" label="" decorative />
      </div>
      <div className="battle-hud">
        <span className="battle-hud-side">己方</span>
        <strong>第 {battle.round} 回合</strong>
        <span className="battle-hud-side battle-hud-side--enemy">敌方 · {enemyLabel}</span>
      </div>
      {battle.units !== undefined && battle.units.length > 0
        ? battle.units.map((unit) => (
            <div
              key={unit.slot}
              className={`battle-combatant battle-combatant--${unit.side === "allies" ? "player" : "enemy"} ${unit.current ? "battle-combatant--active" : ""} ${battleFeedback?.kind === "player-action" && unit.side === "allies" ? "battle-combatant--attacking" : ""} ${battleFeedback?.kind === "player-hit" && unit.side === "allies" ? "battle-combatant--hit" : ""} ${battleFeedback?.kind === "enemy-hit" && unit.side === "enemies" ? "battle-combatant--hit" : ""}`}
              data-side={unit.side === "allies" ? "player" : "enemy"}
              data-slot={unit.slot}
              role="group"
              aria-label={`${unit.side === "allies" ? "己方" : "敌方"}：${unit.name}`}
            >
              <div className="battle-combatant-visual" aria-hidden="true">
                <AdventureVisual gameType={gameType} kind={unit.side === "allies" ? "npc" : "enemy"} label="" decorative />
              </div>
              <span className="battle-faction-label">{unit.side === "allies" ? "己方" : "敌方"}{unit.current ? " · 当前行动" : ""}</span>
              <h3>{unit.name}</h3>
              <p>HP {unit.hp}/{unit.maxHp} · EN {unit.energy}/{unit.maxEnergy}</p>
            </div>
          ))
        : <>
            <div
              className={`battle-combatant battle-combatant--player ${battleFeedback?.kind === "player-action" ? "battle-combatant--attacking" : ""} ${battleFeedback?.kind === "player-hit" ? "battle-combatant--hit" : ""}`}
              data-side="player"
              role="group"
              aria-label={`己方：${view.player.name}`}
            >
              <div className="battle-combatant-visual" aria-hidden="true">
                <AdventureVisual gameType={gameType} kind="npc" label="" decorative />
              </div>
              <span className="battle-faction-label">己方</span>
              <h3>{view.player.name}</h3>
              <p>HP {battle.playerHp}</p>
            </div>
            <div
              className={`battle-combatant battle-combatant--enemy ${battleFeedback?.kind === "enemy-hit" ? "battle-combatant--hit" : ""}`}
              data-side="enemy"
              role="group"
              aria-label={`敌方：${battle.enemyName}`}
            >
              <div className="battle-combatant-visual" aria-hidden="true">
                <AdventureVisual gameType={gameType} kind="enemy" label="" decorative />
              </div>
              <span className="battle-faction-label">敌方</span>
              <h3>{battle.enemyName}</h3>
              <p>HP {battle.enemyHp}</p>
            </div>
          </>}
      <div className="battle-action-rail" role="group" aria-label="战斗行动">
        {[...battle.controls, ...(battle.disabledControls ?? [])].map(renderBattleChoiceButton)}
      </div>
      {battleFeedback !== null ? (
        <p className={`battle-feedback battle-feedback--${battleFeedback.kind}`} role="status" aria-live="assertive">
          {battleFeedback.message}
        </p>
      ) : null}
      {battle.lastAdvance !== undefined && battle.lastAdvance.length > 0 ? (
        <ol className="battle-log" aria-label="本次行动记录">
          {battle.lastAdvance.map((entry) => (
            <li key={`${entry.round}:${entry.sequence}`}>
              {entry.actorName}{entry.kind === "guard" ? "防御" : entry.kind === "flee" ? "撤退" : entry.kind === "skill" ? "施放技能" : "攻击"}
              {entry.targetName ? ` → ${entry.targetName}` : ""}
              {entry.damage > 0 ? `，${entry.damage} 伤害` : ""}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

// 场景内散布的可探索/调查物品图标位置预设
const ITEM_HOTSPOT_POSITIONS = [
  { top: "38%", left: "22%" },
  { top: "54%", left: "64%" },
  { top: "32%", left: "46%" },
  { top: "66%", left: "30%" },
  { top: "26%", left: "74%" },
  { top: "62%", left: "52%" },
] as const;

function NpcDialogueModal({
  dialogue,
  gameType,
  busy,
  phase,
  nextObjectiveLabel,
  onSubmit,
  onContinue,
  onClose,
}: {
  readonly dialogue: Dialogue;
  readonly gameType: NewGameInput["gameType"];
  readonly busy: boolean;
  readonly phase: DialoguePhase;
  readonly nextObjectiveLabel: string | null;
  readonly onSubmit: (interaction: PlayerInteraction) => void;
  readonly onContinue: () => void;
  readonly onClose: () => void;
}) {
  const [text, setText] = useState("");

  // 焦点 NPC 的正式对话严格由两个批准选项或自由输入标识；
  // 非焦点 NPC 的单个 talk choice 是唯一的正式交谈入口。
  const hasFocusInteraction = dialogue.freeInputEnabled || dialogue.choices.length === 2;

  async function submitFreeText(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const normalized = text.trim();
    if (normalized === "") return;
    onSubmit({ kind: "free_text", text: normalized, targetNpcId: dialogue.npcId });
    setText("");
  }

  return (
    <div className="npc-dialogue-backdrop" role="dialog" aria-modal="true" aria-label={`与${dialogue.name}对话`}>
      <section className="npc-dialogue-panel">
        <button
          type="button"
          className="npc-dialogue-close"
          aria-label="关闭对话"
          onClick={onClose}
        >
          ×
        </button>

        <div className="npc-dialogue-stage">
          {/* 长方形竖版头像 */}
          <figure className="npc-dialogue-figure">
            <div className="npc-dialogue-portrait" aria-hidden="true">
              <AdventureVisual gameType={gameType} kind="npc" label="" decorative />
            </div>
            <h3>{dialogue.name}</h3>
            <span>{dialogue.role}</span>
          </figure>

          <div className="npc-dialogue-speech">
            {phase === "response" ? <span className="npc-dialogue-phase-label">NPC回应</span> : null}
            {dialogue.speechPages.map((page, index) => (
              <p key={`${dialogue.npcId}-${index}`} className="npc-dialogue-speech-text">{normalizeDisplayText(page)}</p>
            ))}
          </div>
        </div>

        {phase === "waiting" ? (
          <p className="npc-dialogue-status" role="status" aria-live="polite">正在等待{dialogue.name}回应……</p>
        ) : phase === "response" ? (
          <>
            {nextObjectiveLabel !== null ? (
              <div className="npc-dialogue-next-step" role="status" aria-live="polite">
                <span>下一步</span>
                <strong>{nextObjectiveLabel}</strong>
              </div>
            ) : null}
            <button type="button" className="npc-dialogue-continue" onClick={onContinue}>
              {hasFocusInteraction ? "继续对话" : "查看下一步"}
            </button>
          </>
        ) : hasFocusInteraction ? (
          /* 焦点 NPC：显示固定选项 + 给予道具 + 自由输入 */
          <>
            <div className="npc-dialogue-choices" role="group" aria-label="对话选项">
              {dialogue.choices.map((choice) => (
                <button
                  key={choice.choiceToken}
                  type="button"
                  disabled={busy}
                  onClick={() => onSubmit({ kind: "fixed_choice", choiceToken: choice.choiceToken })}
                >
                  {choice.label}
                </button>
              ))}
            </div>

            {/* 给予道具：把背包物品交给当前对话 NPC，走正式 give_item 回合 */}
            {dialogue.giveChoices.length > 0 ? (
              <div className="npc-dialogue-give" role="group" aria-label="给予道具">
                <span className="npc-dialogue-give-label">给予道具</span>
                {dialogue.giveChoices.map((entry) => (
                  <button
                    key={entry.choice.choiceToken}
                    type="button"
                    disabled={busy}
                    onClick={() => onSubmit({ kind: "fixed_choice", choiceToken: entry.choice.choiceToken })}
                  >
                    {entry.choice.label}
                  </button>
                ))}
              </div>
            ) : null}

            {dialogue.freeInputEnabled ? (
              <>
                {dialogue.giveChoices.length > 0 ? (
                  <p className="npc-dialogue-input-hint">自定义输入仅用于对白；交付道具请点击上方选项。</p>
                ) : null}
                <form className="npc-dialogue-input" onSubmit={(event) => void submitFreeText(event)}>
                  <input
                    aria-label="自定义回应"
                    value={text}
                    disabled={busy}
                    placeholder="输入回应……"
                    onChange={(event) => setText(event.target.value)}
                    maxLength={240}
                  />
                  <button type="submit" disabled={busy || text.trim() === ""}>发送</button>
                </form>
              </>
            ) : null}
          </>
        ) : (
          /* 非焦点 NPC：只显示一次真实 ask 行动入口；没有焦点对白时不伪造准备状态 */
          <>
            {dialogue.choices.length > 0 ? (
              <div className="npc-dialogue-choices" role="group" aria-label="对话选项">
                {dialogue.choices.map((choice) => (
                  <button
                    key={choice.choiceToken}
                    type="button"
                    disabled={busy}
                    className="npc-dialogue-talk-cta"
                    onClick={() => onSubmit({ kind: "fixed_choice", choiceToken: choice.choiceToken })}
                  >
                    {choice.label}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

export function LocationSceneScreen({
  view,
  busy,
  onSubmit,
  onReturnMap,
  initialFocusNpcId,
  sceneNpcName,
  sceneLocationName,
  sceneBuildingId,
}: LocationSceneScreenProps) {
  const gameType = view.gameType as NewGameInput["gameType"];
  const pending = view.narrativeGeneration.status === "pending";

  const isTest = typeof globalThis !== "undefined" && ("vitest" in globalThis || "vi" in globalThis);

  const activeDialogues = pending
    ? []
    : (view.narrative.npcDialogues ?? []).filter((dialogue) =>
        initialFocusNpcId === null || initialFocusNpcId === undefined || dialogue.npcId === initialFocusNpcId,
      );
  const focusedDialogueName = initialFocusNpcId === null || initialFocusNpcId === undefined
    ? null
    : activeDialogues.find((dialogue) => dialogue.npcId === initialFocusNpcId)?.name ?? null;
  const hasBuildingSceneContext = initialFocusNpcId !== null && initialFocusNpcId !== undefined;
  const buildingItems = hasBuildingSceneContext && view.currentLocation.scale === "town"
    ? view.obtainableItems.filter((item) => item.buildingId === sceneBuildingId)
    : view.obtainableItems;
  const currentSceneNpcName = sceneNpcName ?? focusedDialogueName;
  const locationNpcs = hasBuildingSceneContext
    ? currentSceneNpcName === null
      ? []
      : view.currentLocation.npcs.filter((npc) => npc.name === currentSceneNpcName)
    : view.currentLocation.npcs;
  const activeBuilding = hasBuildingSceneContext
    ? view.currentLocation.town?.interactiveBuildings.find((building) => building.buildingId === sceneBuildingId)
    : undefined;
  const buildingSideNote = activeBuilding === undefined
    ? ""
    : describeBuildingScene(activeBuilding.buildingType, activeBuilding.displayName, sceneNpcName);
  const displayNarration = buildingSideNote || cleanLocationSideNote(normalizeDisplayText(view.narrative.narration ?? ""));
  const displayLocationDescription = activeBuilding === undefined
    ? normalizeDisplayText(view.currentLocation.description)
    : "";
  const shouldShowLocationDescription = displayLocationDescription !== ""
    && (displayNarration === "" || !displayNarration.includes(displayLocationDescription));
  const selectedNpcChoiceToken = currentSceneNpcName === null
    ? null
    : locationNpcs[0]?.talkChoice.choiceToken ?? null;
  // 已准备好的焦点对白代表当前主线的唯一入口。两个 support/challenge 是
  // 对话框内的回答，不应和探索、战斗等地点通用动作并排在底栏；否则一次
  // 主线场景会被误读成多条可同时推进的任务。
  const preparedDialogue = activeDialogues.find((dialogue) =>
    dialogue.choices.length === 2 || dialogue.freeInputEnabled,
  );
  const handoffLeavesCurrentBuilding = selectedNpcChoiceToken !== null
    && view.story.currentObjectiveLabel !== null
    && selectedNpcChoiceToken !== view.story.currentObjectiveChoiceToken;
  const handoffLeavesCurrentLocation = view.story.currentObjectiveLabel !== null
    && view.story.currentObjectiveChoiceToken === null;
  const preparedDialogueTalkChoice = preparedDialogue === undefined
    || handoffLeavesCurrentBuilding
    || handoffLeavesCurrentLocation
    ? null
    : view.currentLocation.npcs.find((npc) => npc.name === preparedDialogue.name)?.talkChoice ?? null;
  // 仍停留在上一座建筑、但主线已交给另一名 NPC 时，不能继续把旧 NPC、
  // 探索或战斗当作当前任务入口。保持原场景供玩家读完回应；下一步由 HUD
  // 指明，玩家返回小镇后从目标人物自己的建筑进入，避免把两处空间混成一幕。
  const sceneActions = preparedDialogueTalkChoice !== null
    ? [preparedDialogueTalkChoice]
    : handoffLeavesCurrentBuilding || handoffLeavesCurrentLocation
      ? []
      : view.story.currentObjectiveChoiceToken !== null
        ? view.currentLocation.actions.filter((action) => action.choiceToken === view.story.currentObjectiveChoiceToken)
        : selectedNpcChoiceToken !== null
          ? view.currentLocation.actions.filter((action) =>
              action.choiceToken === selectedNpcChoiceToken || action.presentation === "battle",
            )
          : view.currentLocation.actions;
  const sceneNarrativeChoices = preparedDialogue === undefined
    && !handoffLeavesCurrentBuilding
    && view.story.currentObjectiveLabel === null
    && view.narrative.eventKind !== "dialogue"
    ? view.narrative.choices
    : [];
  const sceneActionTokens = new Set(sceneActions.map((action) => action.choiceToken));
  const sceneActionLabels = new Set(sceneActions.map((action) => action.label));
  const actionRailChoices = [
    ...sceneActions,
    ...sceneNarrativeChoices.filter((choice) =>
      !sceneActionTokens.has(choice.choiceToken) && !sceneActionLabels.has(choice.label),
    ),
  ];
  const hasDialogueInteraction = activeDialogues.some((dialogue) =>
    dialogue.choices.length > 0 || dialogue.freeInputEnabled,
  );

  // 统一构建所有 NPC 的 Dialogue 数据（包含活跃对话与非活跃 NPC 的打招呼降级对话）
  const allDialoguesMap = new Map<string, Dialogue>();

  for (const d of activeDialogues) {
    allDialoguesMap.set(d.npcId, d);
  }

  for (const npc of locationNpcs) {
    const existing = Array.from(allDialoguesMap.values()).find((d) => d.name === npc.name);
    if (!existing) {
      const fallbackId = `npc_talk_${npc.talkChoice.choiceToken}`;
      allDialoguesMap.set(fallbackId, {
        npcId: fallbackId,
        name: npc.name,
        role: npc.role,
        speechPages: [composeDirectNpcGreeting(npc.role, npc.name)],
        choices: [npc.talkChoice],
        freeInputEnabled: false,
        giveChoices: [],
      });
    }
  }

  const initialOpenDialogueNpcId = (() => {
    // 从小镇建筑进入只切换场景，不自动打开或提交对话；测试环境下仍默认打开第一个活跃对话。
    if (initialFocusNpcId !== null && initialFocusNpcId !== undefined) {
      return null;
    }
    if (isTest && activeDialogues.length > 0) {
      return activeDialogues[0].npcId;
    }
    return null;
  })();
  const [dialogueUi, dispatchDialogueUi] = useReducer(reduceDialogueUiState, {
    npcId: initialOpenDialogueNpcId,
    revision: view.revision,
  });
  const openDialogueNpcId = dialogueUi.npcId;
  const [dialoguePhase, setDialoguePhase] = useState<DialoguePhase>("choice");
  const [nextObjectiveLabel, setNextObjectiveLabel] = useState<string | null>(null);
  const submittedDialogueRef = useRef<SubmittedDialogue | null>(null);
  const previousBusyRef = useRef(busy);

  function setOpenDialogueNpcId(npcId: string | null): void {
    dispatchDialogueUi({ kind: "set", npcId });
  }

  function resetDialogue(): void {
    setOpenDialogueNpcId(null);
    setDialoguePhase("choice");
    setNextObjectiveLabel(null);
    submittedDialogueRef.current = null;
  }
  const [battleFeedback, setBattleFeedback] = useState<BattleFeedback | null>(null);
  const previousBattleRef = useRef(view.battle);

  useEffect(() => {
    const previous = previousBattleRef.current;
    const current = view.battle;
    previousBattleRef.current = current;

    if (previous !== null && current !== null) {
      const latest = current.lastAdvance?.[0];
      let nextFeedback: BattleFeedback | null = null;
      if (latest?.kind === "flee") {
        nextFeedback = { kind: "resolved", message: `${latest.actorName}撤出战斗` };
      } else if (latest !== undefined && latest.damage > 0) {
        nextFeedback = {
          kind: latest.actorSlot.startsWith("enemy-") ? "player-hit" : "enemy-hit",
          message: `${latest.actorName}${latest.kind === "skill" ? "施放技能" : "攻击"}${latest.targetName ? ` ${latest.targetName}` : ""} -${latest.damage} HP`,
        };
      } else if (current.round > previous.round) {
        nextFeedback = { kind: "resolved", message: `第 ${current.round} 回合开始` };
      }
      if (nextFeedback !== null) window.setTimeout(() => setBattleFeedback(nextFeedback), 0);
      const timer = window.setTimeout(() => setBattleFeedback(null), 1800);
      return () => window.clearTimeout(timer);
    }

    if (previous !== null && current === null) {
      window.setTimeout(() => setBattleFeedback({ kind: "resolved", message: "战斗结算完成" }), 0);
      const timer = window.setTimeout(() => setBattleFeedback(null), 1800);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [view.battle]);

  // 正式对白请求结束后，只有成功推进了回合才进入回应态；失败/拒绝则恢复原选项。
  // 这样网络错误不会让玩家卡在“正在等待回应”。
  useEffect(() => {
    const wasBusy = previousBusyRef.current;
    previousBusyRef.current = busy;
    const submitted = submittedDialogueRef.current;
    if (submitted === null || wasBusy === false || busy) return;

    if (!pending && view.revision > submitted.revision && view.turnNumber > submitted.turnNumber) {
      setNextObjectiveLabel(
        view.story.currentObjectiveLabel !== submitted.objectiveLabel
          ? view.story.currentObjectiveLabel
          : null,
      );
      setDialoguePhase("response");
    } else {
      setDialoguePhase("choice");
      setNextObjectiveLabel(null);
      submittedDialogueRef.current = null;
    }
  }, [busy, pending, view.revision, view.story.currentObjectiveLabel, view.turnNumber]);

  function renderChoiceButton(choice: { choiceToken: string; label: string }) {
    // “与 NPC 交谈”只是打开本幕已经生成好的对话；只有弹窗内的两个选项
    // 或自定义输入才是正式回合，避免进入地点或点开交谈入口就提前编排下一幕。
    const matchingNpc = locationNpcs.find((n) => n.talkChoice.choiceToken === choice.choiceToken);
    if (matchingNpc) {
      return (
        <button
          key={choice.choiceToken}
          type="button"
          disabled={busy || pending}
          onClick={() => {
            const dialogue = Array.from(allDialoguesMap.values()).find((d) => d.name === matchingNpc.name);
            if (dialogue !== undefined) {
              setOpenDialogueNpcId(dialogue.npcId);
              setDialoguePhase("choice");
              setNextObjectiveLabel(null);
              submittedDialogueRef.current = null;
            }
          }}
        >
          {choice.label}
        </button>
      );
    }

    return (
      <button
        key={choice.choiceToken}
        type="button"
        disabled={busy || pending}
        onClick={() => onSubmit({ kind: "fixed_choice", choiceToken: choice.choiceToken })}
      >
        {choice.label}
      </button>
    );
  }

  // 右侧侧边栏列表
  const sidebarNpcs: Array<{
    id: string;
    name: string;
    role: string;
    hasActiveDialogue: boolean;
    dialogueId: string;
  }> = [];

  const addedNames = new Set<string>();

  for (const d of activeDialogues) {
    addedNames.add(d.name);
    sidebarNpcs.push({
      id: d.npcId,
      name: d.name,
      role: d.role,
      hasActiveDialogue: true,
      dialogueId: d.npcId,
    });
  }

  for (const npc of locationNpcs) {
    if (!addedNames.has(npc.name)) {
      addedNames.add(npc.name);
      const fallbackId = `npc_talk_${npc.talkChoice.choiceToken}`;
      sidebarNpcs.push({
        id: fallbackId,
        name: npc.name,
        role: npc.role,
        hasActiveDialogue: false,
        dialogueId: fallbackId,
      });
    }
  }

  // 当前打开的对话对象
  const openDialogue: Dialogue | undefined = openDialogueNpcId
    ? allDialoguesMap.get(openDialogueNpcId)
    : undefined;

  // 幕交接时旧焦点 NPC 可能只剩一次普通 ask 入口。若继续保留旧弹窗，
  // 玩家会看到单个“与 NPC 交谈”按钮，却误以为仍在正式双选项对话中。
  // 用 reducer 同步 revision，避免 effect 内直接 setState 触发 cascading render。
  useEffect(() => {
    if (dialogueUi.revision === view.revision) return;
    const shouldPreserveResponse = dialoguePhase === "response" || submittedDialogueRef.current !== null;
    const shouldClose = !pending && !shouldPreserveResponse
      && (
        handoffLeavesCurrentBuilding
        || handoffLeavesCurrentLocation
        || (
          view.narrative.eventKind === "dialogue"
          && openDialogue !== undefined
          && !openDialogue.freeInputEnabled
          && openDialogue.choices.length !== 2
        )
      );
    dispatchDialogueUi({ kind: "sync_revision", revision: view.revision, close: shouldClose });
  }, [
    dialogueUi.revision,
    handoffLeavesCurrentBuilding,
    handoffLeavesCurrentLocation,
    dialoguePhase,
    openDialogue,
    pending,
    view.narrative.eventKind,
    view.revision,
  ]);

  // 点击 NPC 卡片：纯粹打开对话弹窗，不消费回合
  function handleNpcCardClick(npc: typeof sidebarNpcs[number]) {
    setOpenDialogueNpcId(npc.dialogueId);
    setDialoguePhase("choice");
    setNextObjectiveLabel(null);
    submittedDialogueRef.current = null;
  }

  if (view.battle !== null) {
    return (
      <BattleScene
        view={view}
        battle={view.battle}
        gameType={gameType}
        busy={busy}
        pending={pending}
        battleFeedback={battleFeedback}
        onBattleFeedback={(message) => setBattleFeedback({ kind: "player-action", message })}
        onSubmit={onSubmit}
      />
    );
  }

  return (
    <section className="location-viewport location-viewport--fullscreen" aria-label={`地点场景：${sceneLocationName ?? view.currentLocation.name}`}>
      {/* 全屏场景背景 */}
      <div className="location-backdrop location-backdrop--fullscreen" aria-hidden="true">
        <AdventureVisual gameType={gameType} kind="location_backdrop" label="" decorative />
      </div>

      {/* 右上角返回地图/小镇 */}
      <div className="scene-top-nav">
        <button
          type="button"
          className="scene-return-map-btn"
          onClick={onReturnMap}
        >
          {view.currentLocation.scale === "town" ? "返回小镇" : "返回地图"}
        </button>
      </div>

      {/* 右侧 NPC 侧边栏 */}
      {sidebarNpcs.length > 0 ? (
        <aside className="scene-npc-sidebar" aria-label="场景人物">
          <div className="scene-npc-sidebar-header">
            <span>人物</span>
          </div>
          <div className="scene-npc-sidebar-list">
            {sidebarNpcs.map((npc) => {
              const isSelected = openDialogueNpcId === npc.dialogueId;
              return (
                <button
                  key={npc.id}
                  type="button"
                  className={`scene-npc-card ${npc.hasActiveDialogue ? "scene-npc-card--active" : ""} ${isSelected ? "scene-npc-card--selected" : ""}`}
                  disabled={busy || pending}
                  onClick={() => handleNpcCardClick(npc)}
                >
                  <div className="scene-npc-avatar" aria-hidden="true">
                    <AdventureVisual gameType={gameType} kind="npc" label="" decorative />
                  </div>
                  <div className="scene-npc-info">
                    <strong>{npc.name}</strong>
                    <small>{npc.role}</small>
                  </div>
                  {npc.hasActiveDialogue ? (
                    <span className="scene-npc-badge" title="有话要说">💬</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </aside>
      ) : null}

      {/* 场景主要视窗：含散布调查/物品图标 */}
      <div className="location-scene-content location-scene-content--fullscreen">

        {/* 散布在场景中的可探索/调查物品图标 */}
        {buildingItems.length > 0 ? (
          <div className="scene-interactive-layer" aria-label="可获取物品">
            {buildingItems.map((item, index) => {
              const pos = ITEM_HOTSPOT_POSITIONS[index % ITEM_HOTSPOT_POSITIONS.length];
              return (
                <button
                  key={item.choice.choiceToken}
                  type="button"
                  className="scene-interactive-hotspot"
                  style={{ top: pos.top, left: pos.left }}
                  disabled={busy || pending}
                  onClick={() => onSubmit({ kind: "fixed_choice", choiceToken: item.choice.choiceToken })}
                  aria-label={item.choice.label}
                >
                  <span className="hotspot-visual" aria-hidden="true">
                    <AdventureVisual gameType={gameType} kind="item" label="" decorative />
                  </span>
                  <span className="hotspot-label">{item.choice.label}</span>
                </button>
              );
            })}
          </div>
        ) : null}

        {/* 叙事场景浮层（固定在底部中偏上） */}
        {view.narrative.hasScene && displayNarration ? (
          <section className="scene-narrative scene-narrative--side-note" aria-label="地点旁注">
            <div className="scene-narrative-location-note">
              <span className="scene-narrative-kicker">地点旁注</span>
              <h2>{sceneLocationName ?? view.currentLocation.name}</h2>
              <p>{displayNarration}</p>
            </div>
          </section>
        ) : null}

        {/* 地点描述文字：固定在场景左下角 */}
        {shouldShowLocationDescription ? (
          <p className="location-scene-caption">{displayLocationDescription}</p>
        ) : null}
      </div>

      {/* 底部行动栏：与 NPC 交谈只打开本幕对话，弹窗选项才提交正式回合 */}
      <nav className="scene-action-rail scene-action-rail--bottom" aria-label="行动栏">
        {actionRailChoices.length > 0
          ? actionRailChoices.map(renderChoiceButton)
          : sceneNarrativeChoices.length === 0 && view.battle === null && !hasDialogueInteraction
            ? <span className="scene-action-rail-empty" role="alert">当前场景没有可执行行动，请返回地图或重新载入存档。</span>
            : null}
      </nav>

      {/* NPC 对话模态弹层：只有用户主动点击时才弹出 */}
      {openDialogue ? (
        <NpcDialogueModal
          dialogue={openDialogue}
          gameType={gameType}
          busy={busy || pending}
          onSubmit={(interaction) => {
            // 提交后保留当前 NPC 的会话焦点。pending 期间 activeDialogues 会暂时
            // 让弹窗隐去；下一幕 ready 后，同一 NPC 的新台词会自动回到眼前，玩家
            // 先展示回应，再由玩家确认继续，避免自定义输入像是石沉大海。
            submittedDialogueRef.current = {
              revision: view.revision,
              turnNumber: view.turnNumber,
              objectiveLabel: view.story.currentObjectiveLabel,
            };
            setNextObjectiveLabel(null);
            setDialoguePhase("waiting");
            onSubmit(interaction);
          }}
          phase={dialoguePhase}
          nextObjectiveLabel={nextObjectiveLabel}
          onContinue={() => {
            submittedDialogueRef.current = null;
            if (openDialogue.freeInputEnabled || openDialogue.choices.length === 2) {
              setDialoguePhase("choice");
              setNextObjectiveLabel(null);
            } else {
              resetDialogue();
            }
          }}
          onClose={() => {
            resetDialogue();
          }}
        />
      ) : null}
    </section>
  );
}
