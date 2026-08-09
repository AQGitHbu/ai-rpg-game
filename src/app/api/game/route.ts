import { getServerGameEntryPoints, type CreateGameHttpInput } from "@/game/application/server/compositionRoot";

const GAME_TYPES = new Set(["wuxia", "xianxia", "fantasy", "science_fiction", "urban", "alternate_history", "post_apocalypse"]);
const GAME_LENGTHS = new Set(["short", "medium"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 创建开局允许的顶层字段：核心三字段（gameType/gameLength/restart）之外，
 * 放行 NewGameInput 的角色与世界观字段（domain 层已定义完整校验）。
 * 这些字段当前由世界生成源透传保留，供未来 AI 世界生成器使用；
 * 未知字段仍一律拒绝，保证契约可审查。
 */
const CREATE_INPUT_ALLOWED_KEYS = new Set([
  "gameType", "gameLength", "restart",
  "characterName", "characterIdentity", "characterProfile", "personalityTags",
  "worldPremise", "storyOpening", "narrativeStyle", "contentIntensity",
]);

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function parseCreateInput(body: unknown): CreateGameHttpInput | null {
  if (!isRecord(body)) return null;
  if (!Object.keys(body).every((key) => CREATE_INPUT_ALLOWED_KEYS.has(key))) return null;
  if (typeof body.gameType !== "string" || !GAME_TYPES.has(body.gameType)) return null;
  if (typeof body.gameLength !== "string" || !GAME_LENGTHS.has(body.gameLength)) return null;
  let restart: CreateGameHttpInput["restart"];
  if (body.restart !== undefined) {
    if (!isRecord(body.restart) || !Object.keys(body.restart).every((key) => ["identity", "expectedRevision"].includes(key))) return null;
    if (
      typeof body.restart.identity !== "string"
      || body.restart.identity.length === 0
      || body.restart.identity.length > 128
      || typeof body.restart.expectedRevision !== "number"
      || !Number.isInteger(body.restart.expectedRevision)
      || body.restart.expectedRevision < 0
    ) return null;
    restart = { identity: body.restart.identity, expectedRevision: body.restart.expectedRevision };
  }
  return {
    gameType: body.gameType as CreateGameHttpInput["gameType"],
    gameLength: body.gameLength as CreateGameHttpInput["gameLength"],
    ...(restart === undefined ? {} : { restart }),
    // 透传 NewGameInput 可选字段：类型收窄后交 createGame，当前不使用但保留契约。
    ...(optionalString(body.characterName) === undefined ? {} : { characterName: body.characterName as string }),
    ...(optionalString(body.characterIdentity) === undefined ? {} : { characterIdentity: body.characterIdentity as string }),
    ...(optionalString(body.characterProfile) === undefined ? {} : { characterProfile: body.characterProfile as string }),
    ...(optionalStringArray(body.personalityTags) === undefined ? {} : { personalityTags: body.personalityTags as readonly string[] }),
    ...(optionalString(body.worldPremise) === undefined ? {} : { worldPremise: body.worldPremise as string }),
    ...(optionalString(body.storyOpening) === undefined ? {} : { storyOpening: body.storyOpening as string }),
    ...(optionalString(body.narrativeStyle) === undefined ? {} : { narrativeStyle: body.narrativeStyle as CreateGameHttpInput["narrativeStyle"] }),
    ...(optionalString(body.contentIntensity) === undefined ? {} : { contentIntensity: body.contentIntensity as CreateGameHttpInput["contentIntensity"] }),
  };
}

function statusForCreateFailure(code: string | undefined): number {
  switch (code) {
    case "NO_ACTIVE_GAME": return 404;
    case "GAME_NOT_ENDED": return 422;
    case "INFRASTRUCTURE_FAILURE": return 503;
    default: return 409;
  }
}

// POST /api/game：canonical 创建游戏路由，委托 createGame。
// 额外字段（角色名、世界观等）保留供未来 AI 世界生成器使用。
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
      const input = parseCreateInput(body);
      if (input === null) {
        return new Response(JSON.stringify({ ok: false, code: "INVALID_INPUT" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const result = await entryPoints.createGame(input);
      if (result.ok) {
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(result), {
        status: statusForCreateFailure(result.code),
        headers: { "Content-Type": "application/json" },
      });
    },
    request.headers.get("x-request-trace-id") ?? undefined,
  );
}
