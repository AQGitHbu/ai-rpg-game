import type { Interaction } from "@/game/domain/action";
import { asNpcId, type NpcId } from "@/game/domain/scenarioBlueprint";
import { PLAYER_UTTERANCE_MAX_LENGTH } from "@/game/domain/pendingNarrativeJob";

// ---------------------------------------------------------------------------
// Task 10：严格 API discriminated union 解析器。
// 禁止 `as never` 把原始 body 直接送入 use case；解析器只返回白名单 Interaction。
// - fixed_choice 只允许 { kind, choiceToken }
// - free_text   只允许 { kind, text, targetNpcId? }
// - expectedRevision 必须是非负整数
// - text 长度引用统一常量 PLAYER_UTTERANCE_MAX_LENGTH
// ---------------------------------------------------------------------------

export type V2ParseError = { readonly ok: false; readonly code: "INVALID_INPUT" };

export type V2ActionRequest = {
  readonly ok: true;
  readonly actionId: string;
  readonly interaction: Interaction;
  readonly expectedRevision: number;
};

export type V2ActionRequestResult = V2ActionRequest | V2ParseError;

export type V2DialogueRequest = {
  readonly ok: true;
  readonly npcId: NpcId;
  readonly text: string;
  readonly expectedRevision: number;
};

export type V2DialogueRequestResult = V2DialogueRequest | V2ParseError;

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const codePointLength = (value: string) => Array.from(value).length;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const rejectExtraKeys = (obj: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(obj).every((k) => allowed.includes(k));

/**
 * 解析 POST /api/v2/game/actions 的请求体。
 * 只返回白名单 Interaction；未知 kind/字段、空 token、空/超长 text、
 * 非法 targetNpcId、负数/小数 revision 一律 INVALID_INPUT。
 */
export function parseV2ActionRequest(body: unknown): V2ActionRequestResult {
  if (!isRecord(body)) return { ok: false, code: "INVALID_INPUT" };
  if (typeof body.actionId !== "string" || body.actionId.length === 0) return { ok: false, code: "INVALID_INPUT" };
  if (!isNonNegativeInteger(body.expectedRevision)) return { ok: false, code: "INVALID_INPUT" };
  if (!rejectExtraKeys(body, ["actionId", "expectedRevision", "interaction"])) return { ok: false, code: "INVALID_INPUT" };

  const interaction = body.interaction;
  if (!isRecord(interaction)) return { ok: false, code: "INVALID_INPUT" };

  if (interaction.kind === "fixed_choice") {
    if (!rejectExtraKeys(interaction, ["kind", "choiceToken"])) return { ok: false, code: "INVALID_INPUT" };
    if (typeof interaction.choiceToken !== "string" || interaction.choiceToken.length === 0) {
      return { ok: false, code: "INVALID_INPUT" };
    }
    return {
      ok: true,
      actionId: body.actionId,
      expectedRevision: body.expectedRevision,
      interaction: { kind: "fixed_choice", choiceToken: interaction.choiceToken },
    };
  }

  if (interaction.kind === "free_text") {
    if (!rejectExtraKeys(interaction, ["kind", "text", "targetNpcId"])) return { ok: false, code: "INVALID_INPUT" };
    if (typeof interaction.text !== "string" || interaction.text.length === 0) {
      return { ok: false, code: "INVALID_INPUT" };
    }
    if (codePointLength(interaction.text) > PLAYER_UTTERANCE_MAX_LENGTH) {
      return { ok: false, code: "INVALID_INPUT" };
    }
    if (interaction.targetNpcId !== undefined && typeof interaction.targetNpcId !== "string") {
      return { ok: false, code: "INVALID_INPUT" };
    }
    const interactionOut: Interaction = interaction.targetNpcId === undefined
      ? { kind: "free_text", text: interaction.text }
      : { kind: "free_text", text: interaction.text, targetNpcId: asNpcId(interaction.targetNpcId) };
    return { ok: true, actionId: body.actionId, expectedRevision: body.expectedRevision, interaction: interactionOut };
  }

  return { ok: false, code: "INVALID_INPUT" };
}

/**
 * 解析 POST /api/v2/game/npc/dialogue 的请求体。
 * 合法输入返回白名单 { npcId, text, expectedRevision }。
 */
/**
 * v2.1 错误 → HTTP 状态映射（Spec §16.3）：
 * - 400 输入非法；404 无活动存档；409 stale revision；
 * - 422 行动被规则拒绝（含未知选项）；503 基础设施/AI 暂不可用；
 * - 500 损坏存档或未分类内部错误。
 */
export function httpStatusForV2Code(code: string | undefined): number {
  switch (code) {
    case "INVALID_INPUT":
      return 400;
    case "NO_ACTIVE_GAME":
      return 404;
    case "STALE_GAME_REVISION":
      return 409;
    case "UNKNOWN_CHOICE":
    case "ACTION_REJECTED":
      return 422;
    case "INFRASTRUCTURE_FAILURE":
      return 503;
    default:
      return 500;
  }
}

export function parseV2DialogueRequest(body: unknown): V2DialogueRequestResult {
  if (!isRecord(body)) return { ok: false, code: "INVALID_INPUT" };
  if (typeof body.npcId !== "string" || body.npcId.length === 0) return { ok: false, code: "INVALID_INPUT" };
  if (typeof body.text !== "string" || body.text.length === 0) return { ok: false, code: "INVALID_INPUT" };
  if (codePointLength(body.text) > PLAYER_UTTERANCE_MAX_LENGTH) return { ok: false, code: "INVALID_INPUT" };
  if (!isNonNegativeInteger(body.expectedRevision)) return { ok: false, code: "INVALID_INPUT" };
  if (!rejectExtraKeys(body, ["npcId", "text", "expectedRevision"])) return { ok: false, code: "INVALID_INPUT" };
  return { ok: true, npcId: asNpcId(body.npcId), text: body.text, expectedRevision: body.expectedRevision };
}
