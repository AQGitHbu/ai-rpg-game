import type { Action } from "@/game/domain/action";
import {
  createApprovedChoice,
  semanticSummaryOf,
  type ApprovedChoice,
  type ChoiceProposal,
} from "@/game/domain/approvedChoice";
import type { WorldState } from "@/game/domain/worldState";

// ---------------------------------------------------------------------------
// 场景选项审批（Spec §8）：纯函数、零 AI / IO / 随机。
//
// SceneSource 只输出 ChoiceProposal（label + Action 建议），本管线负责：
//  1. action ∈ legalActionCandidates（规则层给出的合法集合）；
//  2. 目标存在且在场/可达（worldState 硬检查，脱离候选集再次验证）；
//  3. label 与目标名明显不一致（talk/move/attack 必须含目标名）；
//  4. 语义重复（同一 semanticSummary/同一 action）拒绝后发；
//  5. 逐字段重建 ApprovedChoice（token 由服务端铸造），绝不放行 AI 原对象。
//
// 返回 approved + rejected 清单；服务端只持久化 approved 进 choiceRegistry。
// ---------------------------------------------------------------------------

export type ChoiceRejectionReason =
  | "invalid_label"
  | "semantic_duplicate"
  | "illegal_action"
  | "unreachable_target"
  | "mismatched_label";

export type RejectedChoice = {
  readonly label: string;
  readonly reason: ChoiceRejectionReason;
};

export type ApproveSceneChoicesInput = {
  readonly sceneId: string;
  readonly basedOnRevision: number;
  readonly proposals: readonly ChoiceProposal[];
  /** 规则层当前合法候选（如 buildChoiceMap 的世界行动集合）。 */
  readonly legalActionCandidates: readonly Action[];
  readonly worldState: WorldState;
};

export type ApproveSceneChoicesResult = {
  readonly approved: readonly ApprovedChoice[];
  readonly rejected: readonly RejectedChoice[];
};

export function approveSceneChoices(input: ApproveSceneChoicesInput): ApproveSceneChoicesResult {
  const approved: ApprovedChoice[] = [];
  const rejected: RejectedChoice[] = [];
  const seenSummaries = new Set<string>();

  for (const proposal of input.proposals) {
    const label = proposal.label.trim();
    if (label === "") {
      rejected.push({ label: proposal.label, reason: "invalid_label" });
      continue;
    }

    const summary = semanticSummaryOf(proposal.action);
    if (seenSummaries.has(summary)) {
      rejected.push({ label, reason: "semantic_duplicate" });
      continue;
    }

    if (!isLegalCandidate(proposal.action, input.legalActionCandidates)) {
      rejected.push({ label, reason: "illegal_action" });
      continue;
    }

    if (!isTargetReachable(proposal.action, input.worldState)) {
      rejected.push({ label, reason: "unreachable_target" });
      continue;
    }

    if (isLabelMismatched(proposal.action, label, input.worldState)) {
      rejected.push({ label, reason: "mismatched_label" });
      continue;
    }

    const result = createApprovedChoice({
      sceneId: input.sceneId,
      basedOnRevision: input.basedOnRevision,
      label,
      action: proposal.action,
    });
    if (!result.ok) {
      rejected.push({ label, reason: "invalid_label" });
      continue;
    }
    approved.push(result.choice);
    seenSummaries.add(summary);
  }

  return { approved, rejected };
}

/** 候选集合按语义匹配：候选仅声明类型/目标语义，utterance 等表现内容不参与匹配。 */
function isLegalCandidate(action: Action, candidates: readonly Action[]): boolean {
  return candidates.some((c) => semanticSummaryOf(c) === semanticSummaryOf(action));
}

/**
 * 目标存在/在场/可达核查（与候选集合独立，防止规则候选之外的引用混入）。
 * 无实体目标的行动（explore/rest/battle_action/ack_prologue）恒通过。
 */
export function isTargetReachable(action: Action, ws: WorldState): boolean {
  switch (action.type) {
    case "talk": {
      const npc = ws.npcs.find((n) => n.id === action.npcId);
      return npc !== undefined && npc.locationId === ws.currentLocationId;
    }
    case "move": {
      const current = ws.locations.find((l) => l.id === ws.currentLocationId);
      if (current === undefined) return false;
      const target = ws.locations.find((l) => l.id === action.locationId);
      return target !== undefined
        && current.connectedLocationIds.includes(action.locationId)
        && ws.unlockedLocationIds.includes(action.locationId);
    }
    case "attack": {
      const enemy = ws.enemies.find((e) => e.id === action.enemyId);
      return enemy !== undefined
        && enemy.locationId === ws.currentLocationId
        && !ws.defeatedEnemyIds.includes(action.enemyId);
    }
    case "take_item": {
      const current = ws.locations.find((l) => l.id === ws.currentLocationId);
      if (current === undefined) return false;
      const item = ws.items.find((i) => i.id === action.itemId);
      return item !== undefined
        && current.availableItemIds.includes(action.itemId)
        && !ws.inventory.includes(action.itemId);
    }
    case "investigate":
      return ws.worldFacts.some((f) => f.factId === action.factId);
    case "explore":
    case "rest":
    case "battle_action":
    case "ack_prologue":
      return true;
    case "freeform":
      // 玩家自由输入不构成场景选项
      return false;
  }
}

/**
 * label 与 action 明显不一致：
 *  1. talk/move/attack/give_item 的 label 必须包含目标实体名（NPC/地点/敌人名）；
 *  2. label 不得提及与本 action 无关的已知实体名（如"救迷路少女"绑 explore——
 *     label 含在场 NPC 名但 action 不含该目标 → 明显错配拒绝）。
 */
export function isLabelMismatched(action: Action, label: string, ws: WorldState): boolean {
  const targetName = targetNameOf(action, ws);
  if (targetName !== undefined && !label.includes(targetName)) return true;

  const targetedNames = new Set(targetNamesOf(action, ws));
  for (const name of knownEntityNames(ws)) {
    if (targetedNames.has(name)) continue;
    if (name.length >= 2 && label.includes(name)) return true;
  }
  return false;
}

function knownEntityNames(ws: WorldState): readonly string[] {
  return [
    ...ws.locations.map((l) => l.name),
    ...ws.npcs.map((n) => n.name),
    ...ws.enemies.map((e) => e.name),
  ];
}

/** action 自身覆盖的实体名（与 label 强校验同一口径）。 */
function targetNamesOf(action: Action, ws: WorldState): readonly string[] {
  switch (action.type) {
    case "talk": {
      const npc = ws.npcs.find((n) => n.id === action.npcId);
      return npc !== undefined ? [npc.name] : [];
    }
    case "move": {
      const location = ws.locations.find((l) => l.id === action.locationId);
      return location !== undefined ? [location.name] : [];
    }
    case "attack": {
      const enemy = ws.enemies.find((e) => e.id === action.enemyId);
      return enemy !== undefined ? [enemy.name] : [];
    }
    default:
      return [];
  }
}

function targetNameOf(action: Action, ws: WorldState): string | undefined {
  switch (action.type) {
    case "talk": {
      const npc = ws.npcs.find((n) => n.id === action.npcId);
      return npc?.name;
    }
    case "move": {
      const location = ws.locations.find((l) => l.id === action.locationId);
      return location?.name;
    }
    case "attack": {
      const enemy = ws.enemies.find((e) => e.id === action.enemyId);
      return enemy?.name;
    }
    default:
      return undefined;
  }
}