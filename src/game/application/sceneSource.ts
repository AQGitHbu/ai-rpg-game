import type { SceneGenerationContext } from "./sceneGenerationContext";
import type { NarrativeEventState, NarrativeNpcLineState } from "@/game/domain/narrative";
import type { EventCandidate } from "@/game/domain/candidateEvent";
import type { ChoiceProposal } from "@/game/domain/approvedChoice";

/**
 * SceneGenerator 的事件提议（spec §7.4 newEvents）。
 * R4 后为结构化候选事件（含可执行 proposedEffects），由 SceneWriteBack 追加进池。
 */
export type EventProposal = EventCandidate;

/** SceneSource 只负责提案；token 与 ready state 一律由审批边界构造。 */
export type ScenePackageProposal = {
  readonly sceneId: string;
  readonly turn: number;
  readonly narration: string;
  readonly npcLine: NarrativeNpcLineState | null;
  readonly event: NarrativeEventState;
  readonly choiceProposals: readonly [ChoiceProposal, ChoiceProposal];
  readonly eventProposals: readonly EventProposal[];
  readonly source: "generated" | "fallback";
};

/** 兼容现有 source 命名；结果本身就是尚未批准的场景包提案。 */
export type SceneSourceResult = ScenePackageProposal;

/** 可注入的叙事场景 source。离线 fixture 不调用 AI。 */
export type SceneSource = {
  generateScene(context: SceneGenerationContext): Promise<SceneSourceResult>;
};
