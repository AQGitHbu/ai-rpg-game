import { getServerGameEntryPoints, type CreateGameHttpInput } from "@/game/application/server/compositionRoot";

const GAME_TYPES = new Set(["wuxia", "xianxia", "fantasy", "science_fiction", "urban", "alternate_history", "post_apocalypse"]);
const GAME_LENGTHS = new Set(["short", "medium"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCreateInput(body: unknown): CreateGameHttpInput | null {
  if (!isRecord(body)) return null;
  if (!Object.keys(body).every((key) => ["gameType", "gameLength", "restart"].includes(key))) return null;
  if (typeof body.gameType !== "string" || !GAME_TYPES.has(body.gameType)) return null;
  if (typeof body.gameLength !== "string" || !GAME_LENGTHS.has(body.gameLength)) return null;
  let restart: CreateGameHttpInput["restart"];
  if (body.restart !== undefined) {
    if (!isRecord(body.restart) || !Object.keys(body.restart).every((key) => key === "expectedRevision")) return null;
    if (
      typeof body.restart.expectedRevision !== "number"
      || !Number.isInteger(body.restart.expectedRevision)
      || body.restart.expectedRevision < 0
    ) return null;
    restart = { expectedRevision: body.restart.expectedRevision };
  }
  return {
    gameType: body.gameType as CreateGameHttpInput["gameType"],
    gameLength: body.gameLength as CreateGameHttpInput["gameLength"],
    ...(restart === undefined ? {} : { restart }),
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
