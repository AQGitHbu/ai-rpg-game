import { getServerGameEntryPoints, type CreateGameHttpInput } from "@/game/application/server/compositionRoot";
import { parseGameSetup } from "@/game/application/createGame";

const GAME_TYPES = new Set(["wuxia", "xianxia", "fantasy", "science_fiction", "urban", "alternate_history", "post_apocalypse"]);
const GAME_LENGTHS = new Set(["short", "medium"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 创建开局允许的顶层字段：核心三字段（gameType/gameLength/restart）之外，
 * 放行 NewGameInput 的角色与世界观字段；提交任一配置字段时必须整体通过
 * domain validateNewGameInput，校验后的 setup 由世界生成源消费。
 * 未知字段仍一律拒绝，保证契约可审查。
 */
const CREATE_INPUT_ALLOWED_KEYS = new Set([
  "gameType", "gameLength", "restart",
  "characterName", "characterIdentity", "characterProfile", "personalityTags",
  "worldPremise", "storyOpening", "narrativeStyle", "contentIntensity",
]);

function parseCreateInput(body: unknown): { input: CreateGameHttpInput } | { invalid: true; errors?: readonly { field: string; code: string }[] } {
  if (!isRecord(body)) return { invalid: true };
  if (!Object.keys(body).every((key) => CREATE_INPUT_ALLOWED_KEYS.has(key))) return { invalid: true };
  if (typeof body.gameType !== "string" || !GAME_TYPES.has(body.gameType)) return { invalid: true };
  if (typeof body.gameLength !== "string" || !GAME_LENGTHS.has(body.gameLength)) return { invalid: true };
  let restart: CreateGameHttpInput["restart"];
  if (body.restart !== undefined) {
    if (!isRecord(body.restart) || !Object.keys(body.restart).every((key) => ["identity", "expectedRevision"].includes(key))) return { invalid: true };
    if (
      typeof body.restart.identity !== "string"
      || body.restart.identity.length === 0
      || body.restart.identity.length > 128
      || typeof body.restart.expectedRevision !== "number"
      || !Number.isInteger(body.restart.expectedRevision)
      || body.restart.expectedRevision < 0
    ) return { invalid: true };
    restart = { identity: body.restart.identity, expectedRevision: body.restart.expectedRevision };
  }
  const setupResult = parseGameSetup({
    gameType: body.gameType,
    gameLength: body.gameLength,
    characterName: body.characterName,
    characterIdentity: body.characterIdentity,
    characterProfile: body.characterProfile,
    personalityTags: body.personalityTags,
    worldPremise: body.worldPremise,
    storyOpening: body.storyOpening,
    narrativeStyle: body.narrativeStyle,
    contentIntensity: body.contentIntensity,
  });
  if (setupResult !== null && !setupResult.ok) {
    return { invalid: true, errors: setupResult.errors };
  }
  return {
    input: {
      gameType: body.gameType as CreateGameHttpInput["gameType"],
      gameLength: body.gameLength as CreateGameHttpInput["gameLength"],
      ...(restart === undefined ? {} : { restart }),
      ...(setupResult === null || !setupResult.ok ? {} : { setup: setupResult.setup }),
    },
  };
}

function statusForCreateFailure(code: string | undefined, failureKind?: string): number {
  switch (code) {
    case "NO_ACTIVE_GAME": return 404;
    case "GAME_NOT_ENDED": return 422;
    case "INFRASTRUCTURE_FAILURE": return 503;
    case "AI_GENERATION_FAILED": return failureKind === "AI_RESPONSE_INVALID" ? 502 : 503;
    default: return 409;
  }
}

// POST /api/game：canonical 创建游戏路由，委托 createGame。
// 开局配置字段经 domain 校验后作为 setup 由世界生成源消费。
export async function POST(request: Request): Promise<Response> {
  const entryPoints = getServerGameEntryPoints();
  return entryPoints.executeHttpRequest(
    "POST",
    "/api/game",
    async () => {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ ok: false, code: "INVALID_INPUT" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const parsed = parseCreateInput(body);
      if ("invalid" in parsed) {
        return new Response(JSON.stringify({ ok: false, code: "INVALID_INPUT", ...(parsed.errors === undefined ? {} : { errors: parsed.errors }) }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const result = await entryPoints.createGame(parsed.input);
      if (result.ok) {
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(result), {
        status: statusForCreateFailure(result.code, result.failureKind),
        headers: { "Content-Type": "application/json" },
      });
    },
    request.headers.get("x-request-trace-id") ?? undefined,
    request,
  );
}
