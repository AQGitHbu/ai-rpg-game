"use client";

import { useState, useEffect, useReducer, useRef, type FormEvent } from "react";
import { type GameSessionView, type NewGameInput } from "@/game/application";
import type { PlayerChoiceView } from "@/game/application/gameSessionView";
import type { PlayerInteraction } from "./gameActionRequest";
import { AdventureVisual } from "./adventureVisuals";
import { normalizeDisplayText } from "./displayText";

type LocationSceneScreenProps = {
  readonly view: GameSessionView;
  readonly busy: boolean;
  readonly onSubmit: (interaction: PlayerInteraction, origin?: "npc-dialogue") => void;
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
  readonly pendingPlayerResponse: string | null;
  readonly pendingChoiceToken: string | null;
  /**
   * 已提交对白仅用于本页等待态展示。pending read model 不保证保留 choices，
   * 因此不能由它重建已选回应、其它固定选项或给予道具选项。
   */
  readonly pendingDialogue: Dialogue | null;
};

type DialogueUiAction =
  | { readonly kind: "set"; readonly npcId: string | null }
  | { readonly kind: "submit"; readonly playerResponse: string; readonly choiceToken: string | null; readonly dialogue: Dialogue }
  | { readonly kind: "clear_pending" }
  | { readonly kind: "sync_revision"; readonly revision: number; readonly close: boolean };

type DialoguePhase = "choice" | "waiting";

type SubmittedDialogue = {
  readonly revision: number;
  readonly turnNumber: number;
};

function reduceDialogueUiState(state: DialogueUiState, action: DialogueUiAction): DialogueUiState {
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
        ? battle.units.filter((unit) => unit.hp > 0).map((unit) => (
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
  pendingPlayerResponse,
  pendingChoiceToken,
  resetInputNonce,
  handoffAcknowledgement,
  onAcknowledge,
  onSubmit,
  onClose,
}: {
  readonly dialogue: Dialogue;
  readonly gameType: NewGameInput["gameType"];
  readonly busy: boolean;
  readonly phase: DialoguePhase;
  readonly pendingPlayerResponse: string | null;
  readonly pendingChoiceToken: string | null;
  readonly resetInputNonce: number;
  readonly handoffAcknowledgement?: Dialogue["handoffAcknowledgement"] | null;
  readonly onSubmit: (interaction: PlayerInteraction, playerResponse: string) => void;
  readonly onAcknowledge?: () => void;
  readonly onClose: () => void;
}) {
  const [text, setText] = useState("");
  const previousResetInputNonce = useRef(resetInputNonce);

  useEffect(() => {
    if (previousResetInputNonce.current === resetInputNonce) return;
    previousResetInputNonce.current = resetInputNonce;
    setText("");
  }, [resetInputNonce]);

  // 焦点 NPC 的正式对话严格由两个批准选项或自由输入标识；
  // 非焦点 NPC 的单个 talk choice 是唯一的正式交谈入口。
  const hasFocusInteraction = dialogue.freeInputEnabled || dialogue.choices.length === 2;

  async function submitFreeText(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const normalized = text.trim();
    if (normalized === "") return;
    onSubmit({ kind: "free_text", text: normalized, targetNpcId: dialogue.npcId }, normalized);
  }

  const waitingChoices = [
    ...dialogue.choices,
    ...dialogue.giveChoices.map((entry) => entry.choice),
  ];

  return (
    <div 
      className="npc-dialogue-backdrop" 
      role="dialog" 
      aria-modal="true" 
      aria-label={`与${dialogue.name}对话`}
      aria-busy={phase === "waiting"}
    >
      <section className="npc-dialogue-panel">
        <button
          type="button"
          className="npc-dialogue-close"
          aria-label="关闭对话"
          onClick={onClose}
          disabled={busy || phase === "waiting"}
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
            {dialogue.speechPages.map((page, index) => (
              <p key={`${dialogue.npcId}-${index}`} className="npc-dialogue-speech-text">{normalizeDisplayText(page)}</p>
            ))}
            {pendingPlayerResponse !== null && pendingChoiceToken === null ? (
              <p className="npc-dialogue-speech-text npc-dialogue-speech-text--player">
                {normalizeDisplayText(pendingPlayerResponse)}
                {phase === "waiting" ? <span data-testid="npc-dialogue-spinner" className="npc-dialogue-inline-spinner" aria-hidden="true" /> : null}
              </p>
            ) : null}
          </div>
        </div>

        {phase === "waiting" ? (
          <>
            <div className="npc-dialogue-choices" role="group" aria-label="对话选项">
              {waitingChoices.map((choice) => (
                <button
                  key={choice.choiceToken}
                  type="button"
                  disabled={true}
                  aria-current={choice.choiceToken === pendingChoiceToken ? "true" : undefined}
                  className={choice.choiceToken === pendingChoiceToken ? "npc-dialogue-choice--selected" : undefined}
                >
                  {choice.label}
                  {choice.choiceToken === pendingChoiceToken ? <span data-testid="npc-dialogue-spinner" className="npc-dialogue-inline-spinner" aria-hidden="true" /> : null}
                </button>
              ))}
            </div>
            <p className="npc-dialogue-status" role="status" aria-live="polite">正在等待{dialogue.name}回应……</p>
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
                  onClick={() => onSubmit({ kind: "fixed_choice", choiceToken: choice.choiceToken }, choice.label)}
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
                    onClick={() => onSubmit({ kind: "fixed_choice", choiceToken: entry.choice.choiceToken }, entry.choice.label)}
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
          /* 非焦点 NPC：零回合展示；剧情交接只保留一个真实下一步，
             普通闲聊才允许用 dismiss 关闭。 */
          <>
            {dialogue.choices.length > 0 ? (
              <div className="npc-dialogue-choices" role="group" aria-label="对话选项">
                {dialogue.choices.map((choice) => (
                  <button
                    key={choice.choiceToken}
                    type="button"
                    disabled={busy}
                    className="npc-dialogue-talk-cta"
                    onClick={() => onSubmit({ kind: "fixed_choice", choiceToken: choice.choiceToken }, choice.label)}
                  >
                    {choice.label}
                  </button>
                ))}
              </div>
            ) : handoffAcknowledgement !== null && handoffAcknowledgement !== undefined ? (
              <div className="npc-dialogue-choices" role="group" aria-label="对话选项">
                <button
                  type="button"
                  className="npc-dialogue-talk-cta"
                  onClick={onAcknowledge ?? onClose}
                >
                  {normalizeDisplayText(handoffAcknowledgement.label)}
                </button>
              </div>
            ) : (
              <div className="npc-dialogue-choices" role="group" aria-label="对话操作">
                <button
                  type="button"
                  className="npc-dialogue-dismiss-btn"
                  disabled={busy}
                  onClick={onClose}
                >
                  知道了
                </button>
              </div>
            )}
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

  const activeDialogues = (view.narrative.npcDialogues ?? []).filter((dialogue) =>
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
  const selectedNpcChoiceToken = currentSceneNpcName === null
    ? null
    : locationNpcs[0]?.talkChoice?.choiceToken ?? null;
  // 权威当前目标的可执行行动集合：优先当前目标的全量 token（discover_fact
  // 多 approach 时保留全部调查方法），兼容旧单一 token（降级为单元素集合）。
  // Task 5：不再用单一 currentObjectiveChoiceToken 把第二个调查方法过滤掉。
  const currentObjectiveTokens = view.story.currentObjectiveChoiceTokens.length > 0
    ? view.story.currentObjectiveChoiceTokens
    : view.story.currentObjectiveChoiceToken === null ? [] : [view.story.currentObjectiveChoiceToken];
  const currentObjectiveAction = (() => {
    if (currentObjectiveTokens.length === 0) return null;
    for (const token of currentObjectiveTokens) {
      const hit = view.currentLocation.actions.find((action) => action.choiceToken === token)
        ?? buildingItems.find((item) => item.choice.choiceToken === token)?.choice
        ?? view.narrative.choices.find((choice) => choice.choiceToken === token);
      if (hit !== null && hit !== undefined) return hit;
    }
    return null;
  })();
  const currentObjectiveIsSceneAction = currentObjectiveAction !== null
    && (currentObjectiveAction.presentation === "explore"
      || currentObjectiveAction.presentation === "battle"
      || currentObjectiveAction.presentation === "travel"
      || currentObjectiveAction.presentation === "investigate"
      || (currentObjectiveAction.presentation === "item"
        && buildingItems.some((item) => item.choice.choiceToken === currentObjectiveAction.choiceToken)));
  // 交接到同一地点的下一位 NPC 时，当前目标的 talk action 仍是一个有效的
  // 单线入口。它不是“离开当前建筑”的空状态：旧 NPC 需要先把最后一句话
  // 展示完，再由唯一的“与下一位 NPC 交谈”按钮把玩家交给下一步。
  const currentObjectiveIsPresentNpcDialogue = currentObjectiveAction?.presentation === "dialogue"
    && view.currentLocation.npcs.some((npc) =>
      npc.talkChoice?.choiceToken === currentObjectiveAction.choiceToken,
    );
  // 动态行动场景（调查/拾取/移动）与目标交接场景的旁注是玩家刚触发的
  // 剧情反馈（含焦点 NPC 的引导词），必须优先于静态建筑氛围；初始进入
  // 或纯对话/观察场景才展示建筑描述。
  const dynamicNarration = cleanLocationSideNote(normalizeDisplayText(view.narrative.narration ?? ""));
  const hasDynamicActionNarration = dynamicNarration !== ""
    && (view.narrative.eventKind === "investigate"
      || view.narrative.eventKind === "item"
      || view.narrative.eventKind === "travel"
      || currentObjectiveIsSceneAction);
  const displayNarration = hasDynamicActionNarration
    ? dynamicNarration
    : (buildingSideNote || dynamicNarration);
  const displayLocationDescription = activeBuilding === undefined
    ? normalizeDisplayText(view.currentLocation.description)
    : "";
  const shouldShowLocationDescription = displayLocationDescription !== ""
    && (displayNarration === "" || !displayNarration.includes(displayLocationDescription));
  // 已准备好的焦点对白代表当前主线的唯一入口。两个 support/challenge 是
  // 对话框内的回答，不应和探索、战斗等地点通用动作并排在底栏；否则一次
  // 主线场景会被误读成多条可同时推进的任务。
  const preparedDialogue = activeDialogues.find((dialogue) =>
    dialogue.choices.length === 2 || dialogue.freeInputEnabled,
  );
  const sceneNpcIsObjectiveTalkTarget = selectedNpcChoiceToken !== null
    && selectedNpcChoiceToken === view.story.currentObjectiveChoiceToken;
  const handoffLeavesCurrentBuilding = hasBuildingSceneContext
    && view.story.currentObjectiveLabel !== null
    && !currentObjectiveIsSceneAction
    && !currentObjectiveIsPresentNpcDialogue
    && !sceneNpcIsObjectiveTalkTarget;
  const handoffLeavesCurrentLocation = view.story.currentObjectiveLabel !== null
    && view.story.currentObjectiveChoiceToken === null;
  // 当前目标是调查/拾取/战斗/移动时，必须优先给出该规则行动（移动含
  // 对话回合预生成的交接选项）。否则上一轮对话仍有两项回应时会抢占底栏，
  // 物品热点又可能被地点旁注遮住，玩家会失去唯一可推进的入口。
  // 仍停留在上一座建筑、但主线目标不在当前地点或没有权威行动入口时，不能
  // 继续把旧 NPC、探索或战斗当作当前任务入口。若目标是同地点另一建筑的 NPC，
  // 则由旧对话保留最后一句和唯一 talk 引导，玩家关闭后返回小镇进入目标建筑。
  const sceneActions = (() => {
    if (handoffLeavesCurrentBuilding || handoffLeavesCurrentLocation) return [];
    if (currentObjectiveTokens.length === 0) return view.currentLocation.actions;
    // 目标 token 集合可以命中地点行动栏、建筑内物品或对话回合预生成的
    // 交接选项（move）——多调查方法时全部保留，同 token 只留一个入口。
    const byToken = new Map<string, PlayerChoiceView>();
    for (const token of currentObjectiveTokens) {
      const hit = view.currentLocation.actions.find((action) => action.choiceToken === token)
        ?? buildingItems.find((item) => item.choice.choiceToken === token)?.choice
        ?? view.narrative.choices.find((choice) => choice.choiceToken === token);
      if (hit !== undefined) byToken.set(token, hit);
    }
    return [...byToken.values()];
  })();
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
  // 地图已经是移动入口，右侧人物卡已经是 NPC 入口；底栏只保留当前场景
  // 没有专属入口的真实行动，避免把同一个主线选择重复投影成提示按钮。
  const visibleActionRailChoices = actionRailChoices.filter((choice) =>
    choice.presentation !== "travel" && choice.presentation !== "dialogue",
  );
  const handoffPlayerResponse = currentObjectiveAction?.presentation === "travel"
    || currentObjectiveAction?.presentation === "dialogue"
    ? currentObjectiveAction.label
    : null;
  // 统一构建所有 NPC 的 Dialogue 数据（读模型已为在场全部 NPC 投影对话，
  // 含非焦点 NPC 的零回合闲聊；此处不再用问候语合成缺省条目）。
  const allDialoguesMap = new Map<string, Dialogue>();

  for (const d of activeDialogues) {
    allDialoguesMap.set(d.npcId, d);
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
    pendingPlayerResponse: null,
    pendingChoiceToken: null,
    pendingDialogue: null,
  });
  const openDialogueNpcId = dialogueUi.npcId;
  const [dialoguePhase, setDialoguePhase] = useState<DialoguePhase>("choice");
  const [dialogueInputResetNonce, setDialogueInputResetNonce] = useState(0);
  const submittedDialogueRef = useRef<SubmittedDialogue | null>(null);
  const previousBusyRef = useRef(busy);

  function setOpenDialogueNpcId(npcId: string | null): void {
    dispatchDialogueUi({ kind: "set", npcId });
  }

  function resetDialogue(): void {
    dispatchDialogueUi({ kind: "set", npcId: null });
    setDialoguePhase("choice");
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

  // 正式对白请求结束后直接恢复下一组选项。普通拒绝/错误不会产生新 revision，
  // 所以保留自由输入草稿供玩家修正；ready 快照则清空该草稿并直接显示新对白。
  // AI failure 仍保持 busy，因而会保留内联等待态，直到重试真正结束。
  useEffect(() => {
    const wasBusy = previousBusyRef.current;
    previousBusyRef.current = busy;
    const submitted = submittedDialogueRef.current;
    if (submitted === null || wasBusy === false || busy) return;
    setDialoguePhase("choice");
    dispatchDialogueUi({ kind: "clear_pending" });
    if (view.revision !== submitted.revision) {
      setDialogueInputResetNonce((current) => current + 1);
    }
    submittedDialogueRef.current = null;
  }, [busy, view.revision, view.turnNumber]);

  function renderChoiceButton(choice: { choiceToken: string; label: string }) {
    // “与 NPC 交谈”只是打开本幕已经生成好的对话；只有弹窗内的两个选项
    // 或自定义输入才是正式回合，避免进入地点或点开交谈入口就提前编排下一幕。
    const matchingNpc = locationNpcs.find((n) => n.talkChoice?.choiceToken === choice.choiceToken);
    if (matchingNpc) {
      return (
        <button
          key={choice.choiceToken}
          type="button"
          disabled={busy || pending}
          onClick={() => {
            // 按 npcId 精确桥接（同名 NPC 不再错配），allDialoguesMap 以 npcId 为键。
            const dialogue = allDialoguesMap.get(matchingNpc.npcId);
            if (dialogue !== undefined) {
              setOpenDialogueNpcId(dialogue.npcId);
              setDialoguePhase("choice");
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

  for (const d of activeDialogues) {
    sidebarNpcs.push({
      id: d.npcId,
      name: d.name,
      role: d.role,
      hasActiveDialogue: d.choices.length > 0 || d.freeInputEnabled,
      dialogueId: d.npcId,
    });
  }

  // 当前打开的对话对象
  const openDialogue: Dialogue | undefined = openDialogueNpcId
    ? allDialoguesMap.get(openDialogueNpcId)
    : undefined;
  // 成功规则提交后的 pending 快照不会携带旧的 approved choices。等待中只能
  // 使用提交前捕获的临时展示快照；ready 写回后 effect 会清理它并显示新场景。
  const displayedDialogue = dialoguePhase === "waiting" && dialogueUi.pendingDialogue !== null
    ? dialogueUi.pendingDialogue
    : openDialogue;

  // 幕交接时旧焦点 NPC 可能只剩一次普通 ask 入口。若继续保留旧弹窗，
  // 玩家会看到单个“与 NPC 交谈”按钮，却误以为仍在正式双选项对话中。
  // 用 reducer 同步 revision，避免 effect 内直接 setState 触发 cascading render。
  useEffect(() => {
    if (dialogueUi.revision === view.revision) return;
    const shouldPreservePendingDialogue = submittedDialogueRef.current !== null;
    const shouldClose = !pending && !shouldPreservePendingDialogue
      && (
        handoffLeavesCurrentBuilding
        || handoffLeavesCurrentLocation
        || (
          view.narrative.eventKind === "dialogue"
          && openDialogue !== undefined
          && !openDialogue.freeInputEnabled
          && openDialogue.choices.length !== 2
          && handoffPlayerResponse === null
        )
      );
    dispatchDialogueUi({ kind: "sync_revision", revision: view.revision, close: shouldClose });
  }, [
    dialogueUi.revision,
    handoffLeavesCurrentBuilding,
    handoffLeavesCurrentLocation,
    handoffPlayerResponse,
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
    submittedDialogueRef.current = null;
  }

  function submitDialogueInteraction(interaction: PlayerInteraction, playerResponse: string): void {
    const choiceToken = interaction.kind === "fixed_choice" ? interaction.choiceToken : null;
    dispatchDialogueUi({ kind: "submit", playerResponse, choiceToken, dialogue: displayedDialogue ?? openDialogue! });
    submittedDialogueRef.current = {
      revision: view.revision,
      turnNumber: view.turnNumber,
    };
    setDialoguePhase("waiting");
    onSubmit(interaction, "npc-dialogue");
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
          disabled={busy || pending}
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

      {/* 底部行动栏：只保留没有地图/人物专属入口的真实场景行动 */}
      {visibleActionRailChoices.length > 0 ? (
        <nav className="scene-action-rail scene-action-rail--bottom" aria-label="行动栏">
          {visibleActionRailChoices.map(renderChoiceButton)}
        </nav>
      ) : null}

      {/* NPC 对话模态弹层：只有用户主动点击时才弹出 */}
      {displayedDialogue ? (
        <NpcDialogueModal
          dialogue={displayedDialogue}
          gameType={gameType}
          busy={busy || pending}
          handoffAcknowledgement={displayedDialogue.choices.length === 0 && !displayedDialogue.freeInputEnabled
            ? displayedDialogue.handoffAcknowledgement ?? null
            : null}
          pendingPlayerResponse={dialogueUi.pendingPlayerResponse}
          pendingChoiceToken={dialogueUi.pendingChoiceToken}
          resetInputNonce={dialogueInputResetNonce}
          onSubmit={submitDialogueInteraction}
          onAcknowledge={resetDialogue}
          phase={dialoguePhase}
          onClose={() => {
            resetDialogue();
          }}
        />
      ) : null}
    </section>
  );
}
