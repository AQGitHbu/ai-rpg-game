import type { Action } from "./action";

// ---------------------------------------------------------------------------
// ApprovedChoice：服务端审批后的场景选项（Spec §8.2）。
//
// - choiceToken 是服务器铸造的 opaque token：确定性派生（FNV-1a 摘要），
//   不含 actionKey、实体 ID 或任何可解析业务语义；
// - semanticSummary 是 action 的稳定语义摘要（纯函数），用于
//   a) 审批阶段识别语义重复选项；b) 注册表去重。
// - ApprovedChoice 只存在于服务端持久化层（choiceRegistry），不得进入
//   read model；客户端只能拿到 { choiceToken, label, hint? }。
// - ApprovedChoice 的唯一构造入口是 createApprovedChoice：registry 内条目
//   的 token/semanticSummary 全部由它派生，杜绝手工伪造。
// ---------------------------------------------------------------------------

/** 服务端持久化的已审批选项（Spec §8.2，verbatim）。 */
export type ApprovedChoice = {
  readonly choiceToken: string;
  readonly sceneId: string;
  readonly basedOnRevision: number;
  readonly label: string;
  readonly action: Action;
  readonly semanticSummary: string;
};

/**
 * SceneSource 的输出建议（候选）：source 只能提出 label + 希望玩家执行的
 * Action；token、sceneId、basedOnRevision 由服务端在审批时铸造。
 * SceneSource 不得直接输出 ApprovedChoice。
 */
export type ChoiceProposal = {
  readonly label: string;
  /** 展示辅助信息（如"将引入新 NPC"），不进 Action。 */
  readonly hint?: string;
  readonly action: Action;
};

export type CreateApprovedChoiceInput = {
  readonly sceneId: string;
  readonly basedOnRevision: number;
  readonly label: string;
  readonly action: Action;
};

export type CreateApprovedChoiceResult =
  | { readonly ok: true; readonly choice: ApprovedChoice }
  | { readonly ok: false; readonly reason: "empty_label" | "invalid_revision" | "empty_scene" };

/** 逐字段重建批准选项：禁止原引用直达注册表。 */
export function createApprovedChoice(input: CreateApprovedChoiceInput): CreateApprovedChoiceResult {
  const label = input.label.trim();
  if (label === "") return { ok: false, reason: "empty_label" };
  if (input.sceneId.trim() === "") return { ok: false, reason: "empty_scene" };
  if (!Number.isInteger(input.basedOnRevision) || input.basedOnRevision < 0) {
    return { ok: false, reason: "invalid_revision" };
  }
  return {
    ok: true,
    choice: {
      choiceToken: deriveChoiceToken({
        sceneId: input.sceneId,
        basedOnRevision: input.basedOnRevision,
        action: input.action,
      }),
      sceneId: input.sceneId,
      basedOnRevision: input.basedOnRevision,
      label,
      action: rebuildAction(input.action),
      semanticSummary: semanticSummaryOf(input.action),
    },
  };
}

/** action 逐字段重建（去掉 utterance 等表现性字段的引用关系不需要，但保持新对象）。 */
function rebuildAction(action: Action): Action {
  switch (action.type) {
    case "talk":
      return { type: "talk", npcId: action.npcId, dialogueAct: action.dialogueAct };
    case "move":
      return { type: "move", locationId: action.locationId };
    case "explore":
      return { type: "explore" };
    case "investigate":
      return { type: "investigate", factId: action.factId };
    case "take_item":
      return { type: "take_item", itemId: action.itemId };
    case "attack":
      return { type: "attack", enemyId: action.enemyId };
    case "battle_action":
      return { type: "battle_action", action: action.action };
    case "rest":
      return { type: "rest" };
    case "ack_prologue":
      return { type: "ack_prologue" };
    case "freeform":
      return { type: "freeform", intent: action.intent, rawText: action.rawText };
  }
}

/**
 * 稳定语义摘要：从 action + act/npc 等推导。
 * 语义相同 → 摘要相同（供去重）；语义不同 → 摘要不同。
 */
export function semanticSummaryOf(action: Action): string {
  switch (action.type) {
    case "talk": return `talk:${action.npcId}:${action.dialogueAct}`;
    case "move": return `move:${action.locationId}`;
    case "explore": return "explore";
    case "investigate": return `investigate:${action.factId}`;
    case "take_item": return `take_item:${action.itemId}`;
    case "attack": return `attack:${action.enemyId}`;
    case "battle_action": return `battle_action:${action.action}`;
    case "rest": return "rest";
    case "ack_prologue": return "ack_prologue";
    case "freeform": return `freeform:${action.intent}`;
  }
}

// ---------------------------------------------------------------------------
// Opaque token：FNV-1a 摘要（纯函数、零随机/时钟）。
// 输出固定 16 位小写 hex，不含任何实体 ID / actionKey / 场景业务串。
// ---------------------------------------------------------------------------

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a(data: string): number {
  let hash = FNV_OFFSET_BASIS >>> 0;
  for (let i = 0; i < data.length; i += 1) {
    hash ^= data.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/** 确定性规范序列化：字段次序固定，跨引擎稳定。 */
function serializeAction(action: Action): string {
  switch (action.type) {
    case "talk": return `talk|${String(action.npcId)}|${action.dialogueAct}`;
    case "move": return `move|${String(action.locationId)}`;
    case "explore": return "explore";
    case "investigate": return `investigate|${String(action.factId)}`;
    case "take_item": return `take_item|${String(action.itemId)}`;
    case "attack": return `attack|${String(action.enemyId)}`;
    case "battle_action": return `battle_action|${action.action}`;
    case "rest": return "rest";
    case "ack_prologue": return "ack_prologue";
    case "freeform": return `freeform|${action.intent}`;
  }
}

/**
 * 服务端铸造的 opaque token：由 sceneId + revision + action 摘要派生，
 * 相同输入必然相同输出；输入任一变化 token 变化。输出不含任何业务语义。
 */
export function deriveChoiceToken(input: {
  readonly sceneId: string;
  readonly basedOnRevision: number;
  readonly action: Action;
}): string {
  const material = `scene:${input.sceneId}|rev:${input.basedOnRevision}|${serializeAction(input.action)}`;
  const partA = fnv1a(material).toString(16).padStart(8, "0");
  const partB = fnv1a(`${material}|salt:2`).toString(16).padStart(8, "0");
  return `c_${partA}${partB}`;
}