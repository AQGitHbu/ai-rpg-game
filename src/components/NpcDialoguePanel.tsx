"use client";

import { useState } from "react";
import type { NewGameInput, NpcDialogueView } from "@/game/application";
import { AdventureVisual } from "./adventureVisuals";

type GameTypeId = NewGameInput["gameType"];

/** 自由输入提交结果：父组件 fetch 对话端点后归一化为两种面板行为。 */
export type FreeInputResult =
  | { readonly kind: "chat"; readonly npcSpeech: string }
  | { readonly kind: "narrative_trigger" };

type NpcDialoguePanelProps = {
  readonly dialogue: NpcDialogueView;
  readonly gameType: GameTypeId;
  /** Phase 14：情境选项提交——choiceToken 来自 currentScene.choices。 */
  readonly onChoice: (choiceToken: string) => void;
  readonly busy: boolean;
  /** 自由输入提交：父组件负责 fetch，返回结果决定面板行为。 */
  readonly onFreeInput: (npcId: string, text: string) => Promise<FreeInputResult>;
  /** 自由输入进行中：禁用发送按钮与输入框。 */
  readonly freeInputBusy?: boolean;
};

/** 翻页箭头：本仓内联装饰性 SVG，零网络、零 AI。 */
function PagerArrowIcon({ direction }: { readonly direction: "prev" | "next" }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" width="14" height="14">
      <path
        d={direction === "prev" ? "M10 3 L5 8 L10 13" : "M6 3 L11 8 L6 13"}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Phase 14 场景化 NPC 对话面板：左侧立绘+名字，右侧分页对白（单页时不显示翻页），
 * 底部编号情境选项 + 独立"回顾已知线索"按钮 + 自由输入框。
 * - choices 与 speechPages 均来自 view.npcDialogues（即 currentScene）。
 * - reviewClues 不再混入 choices，改为独立按钮（始终可点，纯本地展开）。
 * - freeInputEnabled=false 时禁用自由输入框；reviewClues 与 choices 不受影响。
 * 自由输入经 onFreeInput 回调由父组件提交端点：闲聊结果就地显示 NPC 回应；
 * 叙事触发时父组件已切换全局 view，面板不设本地回应。
 */
export function NpcDialoguePanel({
  dialogue,
  gameType,
  onChoice,
  busy,
  onFreeInput,
  freeInputBusy = false
}: NpcDialoguePanelProps) {
  const [cluesExpanded, setCluesExpanded] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [draft, setDraft] = useState("");
  const [localReply, setLocalReply] = useState<string | null>(null);

  const pages = dialogue.speechPages;
  const pageCount = pages.length;
  const safeIndex = Math.min(pageIndex, Math.max(pageCount - 1, 0));
  const hasReviewClues = dialogue.reviewClues.length > 0;
  const freeInputDisabled = !dialogue.freeInputEnabled || freeInputBusy;

  const handleSend = async () => {
    if (!dialogue.freeInputEnabled) return;
    const text = draft.trim();
    if (text === "") return;
    const result = await onFreeInput(dialogue.npcId, text);
    setDraft("");
    // narrative_trigger 时父组件已 onViewChange，生成模态会覆盖仍保留的对话面板，
    // 不设本地回应，避免闪现无意义文本。
    if (result.kind === "chat") {
      setLocalReply(result.npcSpeech);
    }
  };

  return (
    <div className="npc-dialogue-panel">
      <div className="npc-dialogue-stage">
        <div className="npc-dialogue-figure" data-testid="npc-dialogue-figure">
          <AdventureVisual gameType={gameType} kind="npc" label={dialogue.name} decorative />
          <h3>{dialogue.name}</h3>
          <span>{dialogue.role}</span>
        </div>

        <div className="npc-dialogue-speech">
          <p className="npc-dialogue-speech-text">{pages[safeIndex] ?? ""}</p>
          {pageCount > 1 ? (
            <div className="npc-dialogue-pager">
              <button
                type="button"
                aria-label="上一页"
                disabled={safeIndex === 0}
                onClick={() => setPageIndex((index) => Math.max(index - 1, 0))}
              >
                <PagerArrowIcon direction="prev" />
              </button>
              <span className="npc-dialogue-pager-status">
                {safeIndex + 1} / {pageCount}
              </span>
              <button
                type="button"
                aria-label="下一页"
                disabled={safeIndex === pageCount - 1}
                onClick={() => setPageIndex((index) => Math.min(index + 1, pageCount - 1))}
              >
                <PagerArrowIcon direction="next" />
              </button>
            </div>
          ) : null}
          {localReply !== null ? (
            <p className="npc-dialogue-reply" role="status" aria-live="polite">
              {localReply}
            </p>
          ) : null}
          {dialogue.nextEventHint !== undefined ? (
            <p className="npc-dialogue-next-event" role="status" aria-live="polite">
              {dialogue.nextEventHint}
            </p>
          ) : null}
        </div>
      </div>

      <div className="npc-dialogue-choices" role="group" aria-label="对话选项">
        {dialogue.preparingNextScene ? (
          <p className="npc-dialogue-preparing" role="status" aria-live="polite">
            正在准备下一幕…
          </p>
        ) : dialogue.choices.map((choice, index) => (
          <button
            key={choice.choiceToken}
            type="button"
            disabled={busy}
            onClick={() => onChoice(choice.choiceToken)}
          >
            {`${index + 1}. ${choice.label}`}
          </button>
        ))}
      </div>

      {hasReviewClues ? (
        <div className="npc-dialogue-review-toggle">
          <button
            type="button"
            aria-expanded={cluesExpanded}
            aria-controls="npc-dialogue-clues"
            onClick={() => setCluesExpanded((expanded) => !expanded)}
          >
            回顾已知线索
          </button>
        </div>
      ) : null}

      {cluesExpanded && hasReviewClues ? (
        <ul id="npc-dialogue-clues" className="npc-dialogue-clues" aria-label="已知线索">
          {dialogue.reviewClues.map((clue) => (
            <li key={clue}>{clue}</li>
          ))}
        </ul>
      ) : null}

      <form
        className="npc-dialogue-input"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSend();
        }}
      >
        <input
          type="text"
          value={draft}
          placeholder="请输入你的话..."
          aria-label="自由输入"
          disabled={freeInputDisabled}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={freeInputDisabled}>发送</button>
      </form>
    </div>
  );
}
