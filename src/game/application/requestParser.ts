import { asNpcId, type NpcId } from "@/game/domain/worldEntity";
import { PLAYER_UTTERANCE_MAX_LENGTH } from "@/game/domain/pendingNarrativeJob";

// ---------------------------------------------------------------------------
// Task 10：严格 API discriminated union 解析器。
// 禁止 `as never` 把原始 body 直接送入 use case；解析器只返回白名单 Interaction。
// - fixed_choice 只允许 { kind, choiceToken }
// - free_text   只允许 { kind, text, targetNpcId? }
// - expectedRevision 必须是非负整数
// - text 长度引用统一常量 PLAYER_UTTERANCE_MAX_LENGTH
// ---------------------------------------------------------------------------

export type ParseError = { readonly ok: false; readonly code: "INVALID_INPUT" };

export type ActionRequest = {
  readonly actionId: string;
  readonly interaction:
    | { readonly kind: "fixed_choice"; readonly choiceToken: string }
    | { readonly kind: "free_text"; readonly text: string; readonly targetNpcId: NpcId };
  readonly expectedRevision: number;
};

export type ParsedActionRequest = ActionRequest & {
  readonly ok: true;
};

export type ActionRequestResult = ParsedActionRequest | ParseError;

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const codePointLength = (value: string) => Array.from(value).length;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const rejectExtraKeys = (obj: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(obj).every((k) => allowed.includes(k));

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 解析 POST /api/game/actions 的请求体。
 * 只返回白名单 Interaction；未知 kind/字段、空 token、空/超长 text、
 * 非法 targetNpcId、负数/小数 revision 一律 INVALID_INPUT。
 */
export function parseActionRequest(body: unknown): ActionRequestResult {
  if (!isRecord(body)) return { ok: false, code: "INVALID_INPUT" };
  if (typeof body.actionId !== "string" || !UUID_V4.test(body.actionId)) return { ok: false, code: "INVALID_INPUT" };
  if (!isNonNegativeInteger(body.expectedRevision)) return { ok: false, code: "INVALID_INPUT" };
  if (!rejectExtraKeys(body, ["actionId", "expectedRevision", "interaction"])) return { ok: false, code: "INVALID_INPUT" };

  const interaction = body.interaction;
  if (!isRecord(interaction)) return { ok: false, code: "INVALID_INPUT" };

  if (interaction.kind === "fixed_choice") {
    if (!rejectExtraKeys(interaction, ["kind", "choiceToken"])) return { ok: false, code: "INVALID_INPUT" };
    if (typeof interaction.choiceToken !== "string" || interaction.choiceToken.trim().length === 0) {
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
    if (typeof interaction.text !== "string" || interaction.text.trim().length === 0) {
      return { ok: false, code: "INVALID_INPUT" };
    }
    if (codePointLength(interaction.text) > PLAYER_UTTERANCE_MAX_LENGTH) {
      return { ok: false, code: "INVALID_INPUT" };
    }
    if (typeof interaction.targetNpcId !== "string" || interaction.targetNpcId.trim().length === 0) {
      return { ok: false, code: "INVALID_INPUT" };
    }
    const interactionOut: ActionRequest["interaction"] = {
      kind: "free_text",
      text: interaction.text,
      targetNpcId: asNpcId(interaction.targetNpcId),
    };
    return { ok: true, actionId: body.actionId, expectedRevision: body.expectedRevision, interaction: interactionOut };
  }

  return { ok: false, code: "INVALID_INPUT" };
}

/**
 * canonical 错误 → HTTP 状态映射（Spec §16.3）：
 * - 400 输入非法；404 无活动存档；409 stale revision；
 * - 422 行动被规则拒绝（含未知选项）；503 基础设施/AI 暂不可用；
 * - 500 损坏存档或未分类内部错误。
 */
export function httpStatusForCode(code: string | undefined): number {
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
