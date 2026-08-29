"use client";

import { useState, useEffect, useRef, type FormEvent, type KeyboardEvent, type MouseEvent } from "react";
import type { NpcDialogueView, NewGameInput, PlayerChoiceView, RelationshipTier } from "@/game/application";
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

/**
 * 等待态快照中的单个入口：固定回应、赠物项与 startChoice 共用同一渲染，
 * 一律禁用（spec §4.3「所有对话入口锁定」），已提交的那条带 aria-current 与内联 loading。
 */
function WaitingChoiceButton({
  choice,
  selected,
}: {
  readonly choice: PlayerChoiceView;
  readonly selected: boolean;
}) {
  return (
    <button
      type="button"
      data-testid="npc-dialogue-choice"
      disabled={true}
      aria-current={selected ? "true" : undefined}
      className={selected ? "npc-dialogue-overlay-choice--selected" : undefined}
    >
      <span aria-hidden="true">&gt; </span>{choice.label}
      {selected ? (
        <span data-testid="npc-dialogue-spinner" className="npc-dialogue-inline-spinner" aria-hidden="true" />
      ) : null}
    </button>
  );
}

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

  const overlayRef = useRef<HTMLDivElement | null>(null);

  // aria-modal 模态语义：Tab 不得逃出覆盖层，在覆盖层内可聚焦元素间循环；
  // Escape 等价关闭按钮（同一 locked 门禁），IME 组合中的 Escape 是取消候选词、不是关闭意图。
  function handleOverlayKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      if (locked) return;
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const root = overlayRef.current;
    if (root === null) return;
    const focusable = Array.from(
      root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) return;
    const current = focusable.indexOf(document.activeElement as HTMLElement);
    const nextIndex = event.shiftKey
      ? current <= 0 ? focusable.length - 1 : current - 1
      : (current + 1) % focusable.length;
    event.preventDefault();
    focusable[nextIndex]?.focus();
  }

  const locked = busy || phase === "waiting";

  const pages = dialogue.speechPages;
  const lastIndex = Math.max(0, pages.length - 1);
  const [pageIndex, setPageIndex] = useState(0);
  const clampedIndex = Math.min(pageIndex, lastIndex);
  const isLastPage = clampedIndex >= lastIndex;

  // 内容键变化（新回应写回/切换 NPC）才重置；引用变化不重置。
  const contentKey = `${dialogue.npcId}\u0001${pages.join("\u0001")}`;
  const previousContentKey = useRef(contentKey);
  useEffect(() => {
    if (previousContentKey.current === contentKey) return;
    previousContentKey.current = contentKey;
    setPageIndex(0);
  }, [contentKey]);

  function advancePage(): void {
    if (locked) return;
    if (isLastPage) return;
    setPageIndex(clampedIndex + 1);
  }

  // 焦点 NPC 的正式对话严格由两个批准选项或自由输入标识；
  // 非焦点 NPC 的单个 talk choice 是唯一的正式交谈入口。
  const hasFocusInteraction = dialogue.freeInputEnabled || dialogue.choices.length === 2;

  // 非焦点零回合闲聊（无任何入口、非交接收尾）：对话框描边降级为灰色调（spec §2.3）。
  const isAmbientChat = !hasFocusInteraction
    && dialogue.startChoice === undefined
    && dialogue.choices.length === 0
    && (handoffAcknowledgement === null || handoffAcknowledgement === undefined);

  // 等待态快照：固定回应/交接入口与赠物项分开渲染，赠物项保留独立「给予道具」分组，
  // 与 ready 态的分组语义一致（审查 Finding B）。
  const waitingFixedChoices = [
    ...dialogue.choices,
    ...(dialogue.startChoice === undefined ? [] : [dialogue.startChoice]),
  ];

  // 审查 Finding A：对话期间人物侧栏被卸载，NPC 身份只能由覆盖层自己给出，
  // 因此旧模态的角色行必须回到名字横幅。空角色不渲染空行。
  const roleText = normalizeDisplayText(dialogue.role).trim();

  function submitFreeText(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const normalized = text.trim();
    if (normalized === "") return;
    onSubmit({ kind: "free_text", text: normalized, targetNpcId: dialogue.npcId }, normalized);
  }

  // 交互控件（关闭按钮/未来的输入框与选项按钮）冒泡到对话框时不触发翻页。
  function isInteractiveTarget(event: { readonly target: EventTarget | null }): boolean {
    const target = event.target as HTMLElement;
    return typeof target?.closest === "function" && target.closest("input, textarea, button, form") !== null;
  }

  function handleBoxClick(event: MouseEvent<HTMLElement>): void {
    if (isInteractiveTarget(event)) return;
    advancePage();
  }

  function handleBoxKeyDown(event: KeyboardEvent<HTMLElement>): void {
    // IME 组合输入中的确认键是候选词提交，不是翻页意图。
    if (event.nativeEvent.isComposing) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    // 自由输入框持有焦点时保留其输入/提交语义，不触发翻页。
    if (isInteractiveTarget(event)) return;
    event.preventDefault();
    advancePage();
  }

  return (
    <div
      ref={overlayRef}
      className="npc-dialogue-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`与${dialogue.name}对话`}
      aria-busy={phase === "waiting"}
      onKeyDown={handleOverlayKeyDown}
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

      {phase === "waiting" ? (
        <div className="npc-dialogue-overlay-panel" role="group" aria-label="对话选项">
          {waitingFixedChoices.map((choice) => (
            <WaitingChoiceButton
              key={choice.choiceToken}
              choice={choice}
              selected={choice.choiceToken === pendingChoiceToken}
            />
          ))}
          {dialogue.giveChoices.length > 0 ? (
            <div className="npc-dialogue-overlay-give" role="group" aria-label="给予道具">
              <span className="npc-dialogue-overlay-give-label">给予道具</span>
              {dialogue.giveChoices.map((entry) => (
                <WaitingChoiceButton
                  key={entry.choice.choiceToken}
                  choice={entry.choice}
                  selected={entry.choice.choiceToken === pendingChoiceToken}
                />
              ))}
            </div>
          ) : null}
          {/* 等待态不渲染自由输入表单：与现有模态逐条一致（spec §4.3"逐条保留现有行为"），
              壳层用例（AdventureGameShell.test.tsx:355/:1185）断言等待态"自定义回应"输入框不在文档中。
              因此这里也不渲染只针对自由输入的交付提示行。 */}
          <p className="npc-dialogue-overlay-status" role="status" aria-live="polite">正在等待{dialogue.name}回应……</p>
        </div>
      ) : isLastPage ? (
        dialogue.startChoice !== undefined ? (
          <div className="npc-dialogue-overlay-panel" role="group" aria-label="对话选项">
            <button
              type="button"
              className="npc-dialogue-overlay-cta"
              disabled={busy}
              onClick={() => onSubmit({ kind: "fixed_choice", choiceToken: dialogue.startChoice!.choiceToken }, dialogue.startChoice!.label)}
            >
              <span aria-hidden="true">&gt; </span>{dialogue.startChoice.label}
            </button>
          </div>
        ) : hasFocusInteraction ? (
          <div className="npc-dialogue-overlay-panel" role="group" aria-label="对话选项">
            {dialogue.choices.map((choice) => (
              <button
                key={choice.choiceToken}
                type="button"
                data-testid="npc-dialogue-choice"
                disabled={busy}
                onClick={() => onSubmit({ kind: "fixed_choice", choiceToken: choice.choiceToken }, choice.label)}
              >
                <span aria-hidden="true">&gt; </span>{choice.label}
              </button>
            ))}
            {/* spec §2.1 面板顺序：固定选项 → 赠物选项 → 分隔线（输入行 border-top 充当）→ 自由输入 */}
            {dialogue.giveChoices.length > 0 ? (
              <div className="npc-dialogue-overlay-give" role="group" aria-label="给予道具">
                <span className="npc-dialogue-overlay-give-label">给予道具</span>
                {dialogue.giveChoices.map((entry) => (
                  <button
                    key={entry.choice.choiceToken}
                    type="button"
                    data-testid={`npc-dialogue-overlay-give-${entry.choice.choiceToken}`}
                    disabled={busy}
                    onClick={() => onSubmit({ kind: "fixed_choice", choiceToken: entry.choice.choiceToken }, entry.choice.label)}
                  >
                    <span aria-hidden="true">&gt; </span>{entry.choice.label}
                  </button>
                ))}
              </div>
            ) : null}
            {dialogue.freeInputEnabled && dialogue.giveChoices.length > 0 ? (
              <p className="npc-dialogue-overlay-input-hint">自定义输入仅用于对白；交付道具请点击上方选项。</p>
            ) : null}
            {dialogue.freeInputEnabled ? (
              <form className="npc-dialogue-overlay-input" onSubmit={submitFreeText}>
                <input
                  aria-label="自定义回应"
                  value={text}
                  disabled={busy}
                  placeholder="或直接说……"
                  onChange={(event) => setText(event.target.value)}
                  maxLength={240}
                />
                <button type="submit" disabled={busy || text.trim() === ""}>发送</button>
              </form>
            ) : null}
          </div>
        ) : (
          /* 非焦点 NPC：零回合展示；剧情交接只保留一个真实下一步，普通闲聊才用"知道了"关闭 */
          <div className="npc-dialogue-overlay-panel" role="group" aria-label="对话选项">
            {dialogue.choices.length > 0 ? (
              dialogue.choices.map((choice) => (
                <button
                  key={choice.choiceToken}
                  type="button"
                  className="npc-dialogue-overlay-cta"
                  disabled={busy}
                  onClick={() => onSubmit({ kind: "fixed_choice", choiceToken: choice.choiceToken }, choice.label)}
                >
                  <span aria-hidden="true">&gt; </span>{choice.label}
                </button>
              ))
            ) : handoffAcknowledgement !== null && handoffAcknowledgement !== undefined ? (
              <button type="button" className="npc-dialogue-overlay-cta" onClick={onAcknowledge ?? onClose}>
                {normalizeDisplayText(handoffAcknowledgement.label)}
              </button>
            ) : (
              <button type="button" className="npc-dialogue-overlay-dismiss" disabled={busy} onClick={onClose}>
                知道了
              </button>
            )}
          </div>
        )
      ) : null}

      <section
        className={`npc-dialogue-overlay-box${isAmbientChat ? " npc-dialogue-overlay-box--ambient" : ""}`}
        ref={boxRef}
        tabIndex={0}
        onClick={handleBoxClick}
        onKeyDown={handleBoxKeyDown}
      >
        <div className="npc-dialogue-overlay-banner">
          <span className="npc-dialogue-overlay-name">{dialogue.name}</span>
          {roleText !== "" ? <span className="npc-dialogue-overlay-role">{roleText}</span> : null}
        </div>
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
          {pages.length > 0 ? normalizeDisplayText(pages[clampedIndex]) : "还没有开始对话。"}
        </p>
        {pendingPlayerResponse !== null && pendingChoiceToken === null ? (
          <p className="npc-dialogue-overlay-speech npc-dialogue-overlay-speech--player">
            {normalizeDisplayText(pendingPlayerResponse)}
            {phase === "waiting" ? (
              <span data-testid="npc-dialogue-spinner" className="npc-dialogue-inline-spinner" aria-hidden="true" />
            ) : null}
          </p>
        ) : null}
        {!isLastPage && pages.length > 0 ? (
          <span className="npc-dialogue-overlay-next" aria-hidden="true">▶</span>
        ) : null}
      </section>
    </div>
  );
}
