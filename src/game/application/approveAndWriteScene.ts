import { parseEventCandidate } from "@/game/domain/candidateEvent";
import type { EventCandidate } from "@/game/domain/candidateEvent";
import type { EventProposal } from "./sceneSource";
import type { NarrativeSceneState, NarrativeChoiceState } from "@/game/domain/narrative";
import type { SceneGenerationContext } from "./sceneGenerationContext";
import type { FactId, NpcId } from "@/game/domain/scenarioBlueprint";

// ---------------------------------------------------------------------------
// R4（Task 21）：SceneSource 提议 → 候选事件池审批
// 只做 schema 解析与池生命周期（去重 + FIFO 上限），绝不在写回阶段改动
// World State / tension / 任务 / 关系，也绝不立即执行候选。
// ---------------------------------------------------------------------------

/** 候选事件池 FIFO 上限（Spec §11.3）。 */
export const POOL_MAX_CANDIDATES = 8;

export type CandidateRejectionReason =
  | "invalid_schema"
  | "path_patch"
  | "duplicate_id";

export type ApproveSceneEventProposalsResult =
  | {
      readonly ok: true;
      readonly nextCandidateEventPool: readonly EventCandidate[];
      readonly acceptedIds: readonly string[];
      readonly rejected: readonly { readonly id: string; readonly reasonCode: CandidateRejectionReason }[];
    }
  | { readonly ok: false; readonly code: "INTERNAL" };

/**
 * 审批场景提议的候选事件：
 * - 经 `parseEventCandidate` schema 解析，非法候选丢弃，不让整个合法场景失败；
 * - 夹带任意 path patch 的候选以 `path_patch` 分类拒绝；
 * - 与池内已存在 ID 重复的候选以 `duplicate_id` 拒绝；
 * - 合法候选按 FIFO 追加，超出 `POOL_MAX_CANDIDATES` 从池头裁剪。
 * 纯函数：不读时钟/随机数/DB，不改 World/Story 事实。
 */
export function approveSceneEventProposals(input: {
  readonly existingPool: readonly EventCandidate[];
  readonly proposals: readonly EventProposal[];
}): ApproveSceneEventProposalsResult {
  const acceptedIds: string[] = [];
  const rejected: { readonly id: string; readonly reasonCode: CandidateRejectionReason }[] = [];
  const poolIds = new Set(input.existingPool.map((c) => c.id));
  let nextPool = [...input.existingPool];

  for (const proposal of input.proposals) {
    // 1) 同 ID 去重：池内已存在 → 拒绝
    if (poolIds.has(proposal.id)) {
      rejected.push({ id: proposal.id, reasonCode: "duplicate_id" });
      continue;
    }

    // 2) 夹带任意 path patch（封闭 union 之外）→ 明确分类拒绝
    if (containsPathPatch(proposal)) {
      rejected.push({ id: proposal.id, reasonCode: "path_patch" });
      continue;
    }

    // 3) schema 解析：非法（无执行效果/未知 kind/引用缺失）→ 丢弃但记录分类
    const parsed = parseEventCandidate(proposal);
    if (!parsed.ok) {
      rejected.push({ id: proposal.id, reasonCode: "invalid_schema" });
      continue;
    }

    // 4) 合法候选入池
    nextPool = [...nextPool, parsed.candidate];
    poolIds.add(parsed.candidate.id);
    acceptedIds.push(parsed.candidate.id);
  }

  // FIFO 上限：超出从池头裁剪（保留最新的 N 条）
  if (nextPool.length > POOL_MAX_CANDIDATES) {
    nextPool = nextPool.slice(nextPool.length - POOL_MAX_CANDIDATES);
  }

  return { ok: true, nextCandidateEventPool: nextPool, acceptedIds, rejected };
}

/** 检测候选效果是否为封闭 union 之外的任意 path patch。 */
function containsPathPatch(candidate: EventCandidate): boolean {
  return candidate.proposedEffects.some((effect) => {
    const e = effect as unknown as { path?: unknown };
    // 合法的封闭 union effect 均不含 path 字段；任何携带 path 的直接状态写入视为 path patch
    return e.path !== undefined;
  });
}

// ---------------------------------------------------------------------------
// R5（Task 25）：完整场景包审批（narration/dialogue/choices/forbidden facts）
// 核心结构非法 → 整场 fallback；非核心非法（单个选项/候选）→ 丢弃保留合法场景。
// ---------------------------------------------------------------------------

/** 场景核心结构非法时整场回退的原因。 */
export type SceneRejectionCode =
  | "empty_narration"
  | "unknown_dialogue_npc"
  | "npc_uses_forbidden_fact"
  | "semantic_duplicate_choices"
  | "illegal_choice_target";

export type ApproveScenePackageResult =
  | { readonly ok: true; readonly scene: NarrativeSceneState }
  | { readonly ok: false; readonly code: SceneRejectionCode };

/** 校验选项是否为目标语义合法的候选（talk/move/explore 等已批准动作）。 */
function isLegalChoiceTarget(choice: NarrativeChoiceState): boolean {
  if (choice.actionKey === "explore" || choice.actionKey === "rest") return true;
  if (choice.actionKey.startsWith("talk:")) return true;
  if (choice.actionKey.startsWith("move:")) return true;
  return false;
}

/** 判断两个选项是否语义重复（actionKey 归一化后相同）。 */
function semanticKey(choice: NarrativeChoiceState): string {
  return choice.actionKey.trim();
}

/**
 * 审批 AI 生成的场景包（spec §10.3）：
 * - 旁白为空 → 整场拒绝（fallback）；
 * - 台词 NPC 不在场 → 整场拒绝；
 * - NPC 使用 forbidden fact（不在其 known/scene-visible 允许集合）→ 整场拒绝；
 * - 两选项语义重复 → 整场拒绝；
 * - 选项目标非法 → 整场拒绝；
 * - 通过后返回原始 scene（不改写；choiceToken 由写回阶段服务器铸造）。
 * 纯函数：不读时钟/随机数/DB。
 */
export function approveScenePackage(input: {
  readonly context: SceneGenerationContext;
  readonly scene: NarrativeSceneState;
}): ApproveScenePackageResult {
  const { context, scene } = input;

  if (scene.narration.trim() === "") return { ok: false, code: "empty_narration" };

  // 台词归属校验：NPC 必须在场。
  if (scene.npcLine !== null) {
    const present = context.presentNpcs.find((n) => String(n.id) === String(scene.npcLine!.npcId));
    if (present === undefined) return { ok: false, code: "unknown_dialogue_npc" };
    // forbidden fact：usedFactIds 必须是该 NPC 允许集合（known ∪ scene-visible）之一。
    const allowed = new Set<string>([
      ...present.knownFactCards.map((f) => String(f.factId)),
      ...present.sceneVisibleFactIds.map(String),
    ]);
    for (const factId of scene.npcLine.usedFactIds) {
      if (!allowed.has(String(factId))) return { ok: false, code: "npc_uses_forbidden_fact" };
    }
  }

  // 选项：恰好两个、不语义重复、目标合法。
  if (scene.choices.length !== 2) return { ok: false, code: "illegal_choice_target" };
  const [a, b] = scene.choices as readonly [NarrativeChoiceState, NarrativeChoiceState];
  if (semanticKey(a) === semanticKey(b)) return { ok: false, code: "semantic_duplicate_choices" };
  if (!isLegalChoiceTarget(a) || !isLegalChoiceTarget(b)) return { ok: false, code: "illegal_choice_target" };

  return { ok: true, scene };
}
