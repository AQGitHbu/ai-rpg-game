import type { CreateGameResult, NewGameInput } from "@/game/application";
import type { ServerGameEntryPoints } from "@/game/application/server/compositionRoot";

// ---------------------------------------------------------------------------
// POST /api/game 的 HTTP adapter（Task 4）：只做参数/响应映射，无业务逻辑。
// route.ts 保持薄壳注入生产单例，本函数接受任意入口以便测试注入临时 SQLite。
//
// 状态码映射（响应只含稳定代码，绝无 SQL/异常文本/密钥）：
//   201 创建成功（body: { view, generationSource }，来源仅二元安全值）
//   400 MALFORMED_JSON       —— JSON 不合法或不是对象
//   400 UNEXPECTED_FIELDS    —— 出现开局资料之外的字段（seed/gameId/source/state…）
//   400 INVALID_FIELD_TYPES  —— 已知字段的 JSON 类型不对
//   400 INVALID_INPUT        —— domain 校验失败（fieldErrors 透传给表单）
//   409 ACTIVE_GAME_EXISTS   —— 已有当前存档，不覆盖
//   422 GENERATION_INVALID   —— fallback 生成未通过规则校验
//   503 INFRASTRUCTURE_FAILURE
//   500 INTERNAL_ERROR       —— facade 契约外抛错兜底
// ---------------------------------------------------------------------------

/** 浏览器唯一允许提交的开局资料字段：seed、gameId、生成来源均不在其列。 */
const REQUIRED_STRING_FIELDS = [
  "gameType",
  "characterName",
  "characterIdentity",
  "worldPremise",
  "storyOpening",
  "narrativeStyle",
  "contentIntensity"
] as const;

const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  ...REQUIRED_STRING_FIELDS,
  "characterProfile",
  "personalityTags"
]);
const OFFLINE_JOURNEY_PRESET = "phase10-journey-v1";

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

export async function handleCreateGameRequest(
  request: Request,
  entryPoints: Pick<ServerGameEntryPoints, "createGame"> & Partial<Pick<ServerGameEntryPoints, "createOfflineJourneyGame">>
): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return json(400, { code: "MALFORMED_JSON" });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return json(400, { code: "MALFORMED_JSON" });
  }
  const record = parsed as Record<string, unknown>;

  // Development preset is an exclusive, server-recognised marker. It never
  // accepts player input, seed, source or state supplied by the browser.
  if (record["developmentPreset"] === OFFLINE_JOURNEY_PRESET && Object.keys(record).length === 1) {
    if (entryPoints.createOfflineJourneyGame === undefined) {
      return json(403, { code: "DEVELOPMENT_TOOLS_DISABLED" });
    }
    let presetResult;
    try {
      presetResult = await entryPoints.createOfflineJourneyGame();
    } catch {
      return json(500, { code: "INTERNAL_ERROR" });
    }
    if (presetResult.ok) {
      return json(201, { view: presetResult.view, generationSource: presetResult.source });
    }
    if (presetResult.code === "DEVELOPMENT_TOOLS_DISABLED") {
      return json(403, { code: presetResult.code });
    }
    // All remaining failures retain the normal creation response mapping.
    switch (presetResult.code) {
      case "INVALID_INPUT": return json(400, { code: presetResult.code, fieldErrors: presetResult.fieldErrors });
      case "ACTIVE_GAME_EXISTS": return json(409, { code: presetResult.code });
      case "GENERATION_INVALID": return json(422, { code: presetResult.code });
      case "INFRASTRUCTURE_FAILURE": return json(503, { code: presetResult.code });
    }
  }

  // 白名单外字段一律拒收：seed/gameId/生成来源/state 无从由浏览器伪造。
  const unexpected = Object.keys(record)
    .filter((key) => !ALLOWED_FIELDS.has(key))
    .sort();
  if (unexpected.length > 0) {
    return json(400, { code: "UNEXPECTED_FIELDS", fields: unexpected });
  }

  // 已知字段的 JSON 类型守卫：避免非字符串进入 domain 校验（会抛 TypeError）。
  const invalidTypes: string[] = [];
  for (const field of REQUIRED_STRING_FIELDS) {
    if (record[field] !== undefined && typeof record[field] !== "string") {
      invalidTypes.push(field);
    }
  }
  if (record.characterProfile !== undefined && typeof record.characterProfile !== "string") {
    invalidTypes.push("characterProfile");
  }
  const tags = record.personalityTags;
  if (tags !== undefined && !(Array.isArray(tags) && tags.every((t) => typeof t === "string"))) {
    invalidTypes.push("personalityTags");
  }
  if (invalidTypes.length > 0) {
    return json(400, { code: "INVALID_FIELD_TYPES", fields: invalidTypes.sort() });
  }

  // 缺失字段以空值传入：由 domain 统一给出 REQUIRED/INVALID_ENUM 字段错误，
  // adapter 不复制校验规则。枚举字段仅作类型收窄断言，运行时由 domain 校验。
  const input: NewGameInput = {
    gameType: (record.gameType ?? "") as NewGameInput["gameType"],
    characterName: (record.characterName ?? "") as string,
    characterIdentity: (record.characterIdentity ?? "") as string,
    characterProfile: record.characterProfile as string | undefined,
    personalityTags: (record.personalityTags ?? []) as string[],
    worldPremise: (record.worldPremise ?? "") as string,
    storyOpening: (record.storyOpening ?? "") as string,
    narrativeStyle: (record.narrativeStyle ?? "") as NewGameInput["narrativeStyle"],
    contentIntensity: (record.contentIntensity ?? "") as NewGameInput["contentIntensity"]
  };

  let result: CreateGameResult;
  try {
    result = await entryPoints.createGame(input);
  } catch {
    // facade 契约外的意外抛错：稳定代码兜底，异常文本绝不外泄。
    return json(500, { code: "INTERNAL_ERROR" });
  }
  if (result.ok) {
    // 只回传 read model view + 安全来源字段（"generated" | "fallback"）；
    // gameId 已含在 view 内，seed/blueprint/state/诊断信息不存在。
    return json(201, { view: result.view, generationSource: result.source });
  }
  switch (result.code) {
    case "INVALID_INPUT":
      return json(400, { code: result.code, fieldErrors: result.fieldErrors });
    case "ACTIVE_GAME_EXISTS":
      return json(409, { code: result.code });
    case "GENERATION_INVALID":
      return json(422, { code: result.code });
    case "INFRASTRUCTURE_FAILURE":
      return json(503, { code: result.code });
  }
}
