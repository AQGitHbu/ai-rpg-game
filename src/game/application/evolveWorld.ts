import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { Action } from "@/game/domain/action";
import type { EvolutionNeed, ApprovedWorldDelta, WorldDeltaProposal } from "@/game/domain/worldDelta";
import type { WorldEvolutionSource, WorldEvolutionSourceContext } from "./worldEvolutionSource";
import { createDeterministicEvolutionSource } from "./deterministicEvolutionSource";
import {
  approveWorldDelta,
  materializeWorldDelta,
  type ApprovedWorldDeltaCore,
  type WorldDeltaIdOverride,
  type WorldDeltaRejection,
} from "@/game/gameplay/rpg/worldEvolution";

// ---------------------------------------------------------------------------
// Template：application 层世界演化编排。纯触发（需求已由领域派生）→（条件）
// await source 提案 → 纯审批/装配预览状态；不写状态、不做 AI 内置。
// source 抛错/无提案/审批拒绝先走一次确定性 fallback；fallback 仍无法通过时才以
// "未应用"降级，绝不炸穿回合或场景流水线。
// ---------------------------------------------------------------------------

export type EvolveWorldResult =
  | {
      readonly ok: true;
      readonly proposal: WorldDeltaProposal;
      readonly approved: ApprovedWorldDeltaCore;
      readonly delta: ApprovedWorldDelta;
    }
  | {
      readonly ok: false;
      readonly code: "no_need" | "no_proposal" | "rejected" | "source_error";
      readonly rejectionCode?: WorldDeltaRejection;
    };

export type EvolveWorldInput = {
  readonly need: EvolutionNeed;
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly source?: WorldEvolutionSource;
  readonly action?: Action;
  readonly reason: string;
  /** 回合修复路径：把行动引用 ID 原样铸造为缺失实体 ID（只作用于匹配 kind）。 */
  readonly idOverride?: WorldDeltaIdOverride;
  /** live 运行时关闭静默确定性降级；失败时保留需求，等待下一次真实 API。 */
  readonly allowDeterministicFallback?: boolean;
  readonly now: () => string;
};

/** 按行动类型推导回合修复路径所需的 ID 覆写（与确定性 source 的类别映射一致）。 */
export function repairIdOverrideForAction(action: Action): WorldDeltaIdOverride | undefined {
  switch (action.type) {
    case "talk": return { kind: "npc", id: String(action.npcId) };
    case "move": return { kind: "location", id: String(action.locationId) };
    case "investigate": return { kind: "fact", id: String(action.factId) };
    case "take_item": return { kind: "item", id: String(action.itemId) };
    case "attack": return { kind: "enemy", id: String(action.enemyId) };
    default: return undefined;
  }
}

export async function evolveWorld(input: EvolveWorldInput): Promise<EvolveWorldResult> {
  if (input.need.kind === "none") {
    return { ok: false, code: "no_need" };
  }

  const deterministicSource = createDeterministicEvolutionSource();
  const source: WorldEvolutionSource = input.source ?? deterministicSource;

  const context: WorldEvolutionSourceContext = {
    worldState: input.worldState,
    storyState: input.storyState,
    need: input.need,
    action: input.action,
    reason: input.reason,
  };

  const attempt = async (candidateSource: WorldEvolutionSource): Promise<EvolveWorldResult> => {
    let sourceResult;
    try {
      sourceResult = await candidateSource.propose(context);
    } catch {
      return { ok: false, code: "source_error" };
    }
    if (sourceResult.proposal === null) {
      return { ok: false, code: "no_proposal" };
    }

    const approval = approveWorldDelta({
      proposal: sourceResult.proposal,
      need: input.need,
      ws: input.worldState,
      ss: input.storyState,
      idOverride: input.idOverride,
    });
    if (!approval.ok) {
      return { ok: false, code: "rejected", rejectionCode: approval.code };
    }

    const delta = materializeWorldDelta({
      approved: approval.approved,
      need: input.need,
      ws: input.worldState,
      ss: input.storyState,
      now: input.now,
    });

    return { ok: true, proposal: sourceResult.proposal, approved: approval.approved, delta };
  };

  const primary = await attempt(source);
  // AI 的 JSON 可能结构合法但语义不可装配（例如缺少主线锚点、预算超限或
  // 小镇已无可用 slot）。这类失败也必须走离线确定性方案，否则 needs_next_act
  // 会永久挂起，下一场景只会重复同一失败。
  if (primary.ok || input.source === undefined || input.allowDeterministicFallback === false) return primary;
  return attempt(deterministicSource);
}
