"use client";

import { useState, useEffect, useRef, type FormEvent } from "react";
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
};

type Dialogue = NonNullable<GameSessionView["narrative"]["npcDialogues"]>[number];

type BattleFeedback = {
  readonly kind: "player-action" | "enemy-hit" | "player-hit" | "resolved";
  readonly message: string;
};

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
  onSubmit,
  onClose,
}: {
  readonly dialogue: Dialogue;
  readonly gameType: NewGameInput["gameType"];
  readonly busy: boolean;
  readonly onSubmit: (interaction: PlayerInteraction) => void;
  readonly onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [smallTalkShown, setSmallTalkShown] = useState(false);

  // 焦点 NPC 的正式对话严格由两个批准选项或自由输入标识；
  // 非焦点 NPC 的单个 talk choice 只是打开正式交谈的入口，不能吞掉闲聊。
  const hasFocusInteraction = dialogue.freeInputEnabled || dialogue.choices.length === 2;
  const isDialoguePreparing = !hasFocusInteraction
    && !dialogue.freeInputEnabled
    && dialogue.choices.length === 1
    && dialogue.choices[0]?.presentation === "dialogue";

  async function submitFreeText(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const normalized = text.trim();
    if (normalized === "") return;
    onSubmit({ kind: "free_text", text: normalized, targetNpcId: dialogue.npcId });
    setText("");
  }

  function handleSmallTalkClick(): void {
    setSmallTalkShown(true);
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
            {dialogue.speechPages.map((page, index) => (
              <p key={`${dialogue.npcId}-${index}`} className="npc-dialogue-speech-text">{normalizeDisplayText(page)}</p>
            ))}
            {smallTalkShown && dialogue.smallTalk ? (
              <p className="npc-dialogue-speech-text npc-dialogue-small-talk-response">
                {normalizeDisplayText(dialogue.smallTalk.response)}
              </p>
            ) : null}
          </div>
        </div>

        {/* 焦点 NPC：显示固定选项 + 给予道具 + 自由输入 */}
        {hasFocusInteraction ? (
          <>
            {isDialoguePreparing ? (
              <p role="status" aria-live="polite" className="npc-dialogue-preparing">
                正在准备对话……
              </p>
            ) : null}
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
            ) : null}
          </>
        ) : (
          /* 非焦点 NPC：显示闲聊按钮或降级对话选项 */
          <>
            {isDialoguePreparing && !dialogue.smallTalk ? (
              <p role="status" aria-live="polite" className="npc-dialogue-preparing">
                正在准备对话……
              </p>
            ) : null}
            {dialogue.smallTalk && !smallTalkShown ? (
              <button
                type="button"
                className="npc-dialogue-small-talk-btn"
                disabled={busy}
                onClick={handleSmallTalkClick}
              >
                💬 {dialogue.smallTalk.prompt}
              </button>
            ) : null}
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
  const currentSceneNpcName = sceneNpcName ?? focusedDialogueName;
  const locationNpcs = hasBuildingSceneContext
    ? currentSceneNpcName === null
      ? []
      : view.currentLocation.npcs.filter((npc) => npc.name === currentSceneNpcName)
    : view.currentLocation.npcs;
  const displayNarration = normalizeDisplayText(view.narrative.narration ?? "");
  const displayLocationDescription = normalizeDisplayText(view.currentLocation.description);
  const shouldShowLocationDescription = displayLocationDescription !== ""
    && (displayNarration === "" || !displayNarration.includes(displayLocationDescription));
  const selectedNpcChoiceToken = currentSceneNpcName === null
    ? null
    : locationNpcs[0]?.talkChoice.choiceToken ?? null;
  const sceneActions = selectedNpcChoiceToken !== null
    ? view.currentLocation.actions.filter((action) => action.choiceToken === selectedNpcChoiceToken)
    : view.story.currentObjectiveChoiceToken !== null
      ? view.currentLocation.actions.filter((action) => action.choiceToken === view.story.currentObjectiveChoiceToken)
      : view.currentLocation.actions;
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
        speechPages: [composeDirectNpcGreeting()],
        choices: [npc.talkChoice],
        freeInputEnabled: false,
        giveChoices: [],
      });
    }
  }

  const [openDialogueNpcId, setOpenDialogueNpcId] = useState<string | null>(() => {
    // 从小镇建筑进入只切换场景，不自动打开或提交对话；测试环境下仍默认打开第一个活跃对话。
    if (initialFocusNpcId !== null && initialFocusNpcId !== undefined) {
      return null;
    }
    if (isTest && activeDialogues.length > 0) {
      return activeDialogues[0].npcId;
    }
    return null;
  });
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
            if (dialogue !== undefined) setOpenDialogueNpcId(dialogue.npcId);
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

  const openDialogueNpcIdForRender = openDialogueNpcId;

  // 当前打开的对话对象
  const openDialogue: Dialogue | undefined = openDialogueNpcIdForRender
    ? allDialoguesMap.get(openDialogueNpcIdForRender)
    : undefined;

  // 点击 NPC 卡片：纯粹打开对话弹窗，不消费回合
  function handleNpcCardClick(npc: typeof sidebarNpcs[number]) {
    setOpenDialogueNpcId(npc.dialogueId);
  }

  function renderBattleChoiceButton(choice: { choiceToken: string | null; label: string; enabled?: boolean; disabledReason?: string | null }) {
    return (
      <button
        key={`${choice.label}:${choice.choiceToken ?? "disabled"}`}
        type="button"
        data-battle-action="true"
        disabled={busy || pending || choice.enabled === false || choice.choiceToken === null}
        onClick={() => {
          if (choice.choiceToken === null) return;
          setBattleFeedback({ kind: "player-action", message: `你${choice.label}！` });
          onSubmit({ kind: "fixed_choice", choiceToken: choice.choiceToken });
        }}
      >
        {choice.label}{choice.disabledReason ? `（${choice.disabledReason}）` : ""}
      </button>
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
              const isSelected = openDialogueNpcIdForRender === npc.dialogueId;
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
        {view.obtainableItems.length > 0 ? (
          <div className="scene-interactive-layer" aria-label="可获取物品">
            {view.obtainableItems.map((item, index) => {
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

        {/* 编排中提示 */}
        {pending ? (
          <p role="status" aria-live="polite" className="narrative-pending-caption">
            正在编排下一幕……
          </p>
        ) : null}

        {/* 叙事场景浮层（固定在底部中偏上） */}
        {view.narrative.hasScene && displayNarration ? (
          <section className="scene-narrative scene-narrative--overlay" aria-label="当前场景">
            <p>{displayNarration}</p>
            {view.narrative.eventKind !== "dialogue" && view.narrative.choices.length > 0 ? (
              <div role="group" aria-label="场景选项">
                {view.narrative.choices.map(renderChoiceButton)}
              </div>
            ) : null}
          </section>
        ) : null}

        {/* 地点描述文字：固定在场景左下角 */}
        {shouldShowLocationDescription ? (
          <p className="location-scene-caption">{displayLocationDescription}</p>
        ) : null}
      </div>

      {/* 底部行动栏：与 NPC 交谈只打开本幕对话，弹窗选项才提交正式回合 */}
      <nav className="scene-action-rail scene-action-rail--bottom" aria-label="行动栏">
        {sceneActions.length > 0
          ? sceneActions.map(renderChoiceButton)
          : view.narrative.choices.length === 0 && view.battle === null && !hasDialogueInteraction
            ? <span className="scene-action-rail-empty" role="alert">当前场景没有可执行行动，请返回地图或重新载入存档。</span>
            : null}
      </nav>

      {/* 战斗 */}
      {view.battle !== null ? (
        <section className="battle-viewport" aria-label={`战斗 · ${view.battle.enemyName}`}>
          <div className="battle-arena-backdrop" aria-hidden="true">
            <AdventureVisual gameType={gameType} kind="enemy" label="" decorative />
          </div>
          <div className="battle-hud">
            <span className="battle-hud-side">己方</span>
            <strong>第 {view.battle.round} 回合</strong>
            <span className="battle-hud-side battle-hud-side--enemy">敌方 · {view.battle.enemyName}</span>
          </div>
          {view.battle.units !== undefined && view.battle.units.length > 0
            ? view.battle.units.map((unit) => (
                <div
                  key={unit.slot}
                  className={`battle-combatant battle-combatant--${unit.side === "allies" ? "player" : "enemy"} ${unit.current ? "battle-combatant--active" : ""} ${battleFeedback?.kind === "enemy-hit" && unit.side === "enemies" ? "battle-combatant--hit" : ""}`}
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
                  <p>HP {view.battle.playerHp}</p>
                </div>
                <div
                  className={`battle-combatant battle-combatant--enemy ${battleFeedback?.kind === "enemy-hit" ? "battle-combatant--hit" : ""}`}
                  data-side="enemy"
                  role="group"
                  aria-label={`敌方：${view.battle.enemyName}`}
                >
                  <div className="battle-combatant-visual" aria-hidden="true">
                    <AdventureVisual gameType={gameType} kind="enemy" label="" decorative />
                  </div>
                  <span className="battle-faction-label">敌方</span>
                  <h3>{view.battle.enemyName}</h3>
                  <p>HP {view.battle.enemyHp}</p>
                </div>
              </>}
          <div className="battle-action-rail" role="group" aria-label="战斗行动">
            {[...view.battle.controls, ...(view.battle.disabledControls ?? [])].map(renderBattleChoiceButton)}
          </div>
          {battleFeedback !== null ? (
            <p className={`battle-feedback battle-feedback--${battleFeedback.kind}`} role="status" aria-live="assertive">
              {battleFeedback.message}
            </p>
          ) : null}
          {view.battle.lastAdvance !== undefined && view.battle.lastAdvance.length > 0 ? (
            <ol className="battle-log" aria-label="本次行动记录">
              {view.battle.lastAdvance.map((entry) => (
                <li key={`${entry.round}:${entry.sequence}`}>
                  {entry.actorName}{entry.kind === "guard" ? "防御" : entry.kind === "flee" ? "撤退" : entry.kind === "skill" ? "施放技能" : "攻击"}
                  {entry.targetName ? ` → ${entry.targetName}` : ""}
                  {entry.damage > 0 ? `，${entry.damage} 伤害` : ""}
                </li>
              ))}
            </ol>
          ) : null}
        </section>
      ) : null}

      {/* NPC 对话模态弹层：只有用户主动点击时才弹出 */}
      {openDialogue ? (
        <NpcDialogueModal
          dialogue={openDialogue}
          gameType={gameType}
          busy={busy || pending}
          onSubmit={(interaction) => {
            // 正式对白选项消费的是当前场景。先关闭旧弹窗，避免 pending 完成后
            // 同一个 NPC ID 在新场景中重新挂载，看起来像旧选项从未失效。
            setOpenDialogueNpcId(null);
            onSubmit(interaction);
          }}
          onClose={() => {
            setOpenDialogueNpcId(null);
          }}
        />
      ) : null}
    </section>
  );
}
