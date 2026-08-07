import {
  asEndingId,
  type EndingDefinition,
  type EndingId,
  type EndingRequirement,
  type EndingTone,
  type GameState,
  type ProposedEnding,
  type ScenarioBlueprint,
} from "@/game/domain";

// ---------------------------------------------------------------------------
// Phase 14 Task 8：结局审批闸门（spec §结局推演机制 §approveEndingProposal）。
//
// 纯函数：8 步顺序校验，首个失败即返回 reason。AI 提议的 ProposedEnding 经
// 此闸门通过后才能转为 EndingDefinition（含服务端铸造的稳定 id），由调用方
// （application 层）通过 applyEndingToBlueprint 落库。绝不在此处写 state/blueprint。
// 不读 IO、不调用随机源；id 派生仅依赖入参 blueprint.endings（确定性）。
// ---------------------------------------------------------------------------

export type EndingApprovalRejection =
  | "none_proposed"
  | "invalid_payload"
  | "not_locked"
  | "already_proposed"
  | "tone_mismatch"
  | "requirements_invalid"
  | "requirements_unsatisfiable";

export type EndingApprovalDecision =
  | { readonly ok: true; readonly approvedEnding: EndingDefinition }
  | { readonly ok: false; readonly reason: EndingApprovalRejection };

export type ApproveEndingProposalInput = {
  readonly blueprint: ScenarioBlueprint;
  readonly state: GameState;
  /** AI 提议的结局；orchestrateNarrativeScene 在导演未提议时传 undefined。 */
  readonly proposed: ProposedEnding | undefined;
  /**
   * 主线当前幕数（派生值，由调用方经 reconcileMainStoryProgress 从 state.quests
   * 派生后传入）。Fix Round 1：not_locked 闸门改用此派生值，不再读 persisted
   * state.mainStoryProgress.currentAct——后者仅在 performAction 中写回，在
   * orchestrateNarrativeScene 阶段可能仍为初始值（如 0），会导致闸门恒为 not_locked
   * 拒绝、结局审批在生产中永不通过。state 入参仍保留供 already_proposed 闸门读取
   * state.mainStoryProgress.endingProposed。
   */
  readonly currentAct: number;
};

const VALID_TONES: ReadonlySet<EndingTone> = new Set<EndingTone>([
  "triumph",
  "tragedy",
  "bittersweet",
  "ambiguous",
]);

const codePointLength = (value: string) => Array.from(value).length;

/**
 * 8 步闸门：none_proposed → invalid_payload → not_locked → already_proposed
 * → tone_mismatch → requirements_invalid → requirements_unsatisfiable → 通过。
 * 通过时把 ProposedEnding 转为 EndingDefinition（铸造 ending_dyn_<n> id，
 * 丢弃 tone/reason——EndingDefinition 不携带这两个字段）。
 */
export function approveEndingProposal(
  input: ApproveEndingProposalInput,
): EndingApprovalDecision {
  const { blueprint, state, proposed, currentAct } = input;

  // 1. none_proposed：未提议
  if (proposed === undefined || proposed === null) {
    return { ok: false, reason: "none_proposed" };
  }

  // 2. invalid_payload：字段缺失或长度非法
  if (!isValidPayload(proposed)) {
    return { ok: false, reason: "invalid_payload" };
  }

  // 3. not_locked：未达 endingDirection.lockedAt 阈值。Fix Round 1：使用调用方
  //    派生传入的 currentAct（来自 reconcileMainStoryProgress 对 state.quests 的
  //    计数），不读 persisted state.mainStoryProgress.currentAct——后者在
  //    performAction 写回前可能滞后（如初始值 0），会使闸门恒为拒绝。
  const lockedAt = blueprint.endingDirection.lockedAt;
  if (currentAct < lockedAt) {
    return { ok: false, reason: "not_locked" };
  }

  // 4. already_proposed：已提议过（防重复）
  if (state.mainStoryProgress.endingProposed) {
    return { ok: false, reason: "already_proposed" };
  }

  // 5. tone_mismatch：基调不在 possibleTones 内
  const possibleTones = new Set(blueprint.endingDirection.possibleTones);
  if (!possibleTones.has(proposed.tone)) {
    return { ok: false, reason: "tone_mismatch" };
  }

  // 6. requirements_invalid：requirements 引用的 questId/factId 不存在
  if (!areRequirementsReferenced(proposed.requirements, blueprint)) {
    return { ok: false, reason: "requirements_invalid" };
  }

  // 7. requirements_unsatisfiable：所有 requirements 当前均不可达成
  if (areAllRequirementsUnachievable(proposed.requirements, state)) {
    return { ok: false, reason: "requirements_unsatisfiable" };
  }

  // 8. theme_alignment：通过 prompt 约束 + 闸门信任——前 7 步通过即批准。
  //    字段逐项重建（绝不按引用返回 AI 对象），并铸造稳定 ending_dyn_<n> id。
  const approvedEnding: EndingDefinition = {
    id: mintEndingId(blueprint),
    name: proposed.name,
    description: proposed.description,
    requirements: proposed.requirements.map((r) => ({ ...r })) as readonly EndingRequirement[],
  } as EndingDefinition;

  return { ok: true, approvedEnding };
}

/** 字段最小合法性：name/description 非空字符串；requirements 为数组；tone 合法枚举。 */
function isValidPayload(proposed: ProposedEnding): boolean {
  if (typeof proposed.name !== "string" || codePointLength(proposed.name) < 1) return false;
  if (typeof proposed.description !== "string" || codePointLength(proposed.description) < 1) return false;
  if (!Array.isArray(proposed.requirements)) return false;
  if (typeof proposed.tone !== "string" || !VALID_TONES.has(proposed.tone)) return false;
  return true;
}

/** requirements 引用的 questId 必须在 blueprint.quests、factId 必须在 blueprint.world.facts。 */
function areRequirementsReferenced(
  requirements: readonly EndingRequirement[],
  blueprint: ScenarioBlueprint,
): boolean {
  const questIds = new Set(blueprint.quests.map((q) => String(q.id)));
  const factIds = new Set(blueprint.world.facts.map((f) => String(f.id)));
  for (const r of requirements) {
    if (r.kind === "quest_completed" || r.kind === "quest_failed") {
      if (!questIds.has(String(r.questId))) return false;
    } else if (r.kind === "fact_discovered") {
      if (!factIds.has(String(r.factId))) return false;
    }
  }
  return true;
}

/**
 * 「不可达成」最小判定（仅基于 quest 当前状态）：
 *   - quest_completed：quest 状态为 "failed"（无法再完成）→ 不可达成
 *   - quest_failed：quest 状态为 "completed" 或 "closed"（无法再失败）→ 不可达成
 *   - fact_discovered：事实存在于蓝图，运行时仍可调查发现 → 永远可达成
 * 全部 requirements 均不可达成时返回 true（空 requirements 视为可达成，返回 false）。
 */
function areAllRequirementsUnachievable(
  requirements: readonly EndingRequirement[],
  state: GameState,
): boolean {
  if (requirements.length === 0) return false;
  const statusById = new Map(state.quests.map((q) => [String(q.questId), q.status]));
  return requirements.every((r) => {
    if (r.kind === "quest_completed") {
      const status = statusById.get(String(r.questId));
      return status === "failed";
    }
    if (r.kind === "quest_failed") {
      const status = statusById.get(String(r.questId));
      return status === "completed" || status === "closed";
    }
    // fact_discovered：事实可在运行时通过 investigate 发现，视为始终可达成。
    return false;
  });
}

/**
 * 铸造稳定 ending_dyn_<n> id：扫描 blueprint.endings 中已有 ending_dyn_<n>
 * 模式取最大序号 +1；无既有动态结局时从 1 开始。与 compileBlueprintExpansion
 * 的 loc_dyn_<n>/npc_dyn_<n> 模式一致，确保 CAS 写入前的确定性。
 */
function mintEndingId(blueprint: ScenarioBlueprint): EndingId {
  let max = 0;
  for (const ending of blueprint.endings) {
    const match = /^ending_dyn_(\d+)$/.exec(String(ending.id));
    if (match !== null) {
      const n = Number.parseInt(match[1], 10);
      if (n > max) max = n;
    }
  }
  return asEndingId(`ending_dyn_${max + 1}`);
}
