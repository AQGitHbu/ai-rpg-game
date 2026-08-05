/** @vitest-environment node */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { NewGameInput } from "@/game/application";
import {
  createServerGameEntryPoints,
  type ServerGameEntryPoints
} from "@/game/application/server/compositionRoot";
import wuxiaFixture from "../../../../data/fixtures/phase1/wuxia.json";
import { handleCreateGameRequest } from "./createGameHandler";
import { handleCurrentGameRequest } from "./current/currentGameHandler";

// ---------------------------------------------------------------------------
// Task 4：POST /api/game adapter 测试——直接以 Request 调用 handler（route.ts
// 仅做单例接线，保持薄壳）。真实路径用注入 GAME_DB_PATH 的组合根 + tmp/ 临时
// SQLite；错误映射用结构化 stub entry points，绕开生产单例。
// ---------------------------------------------------------------------------

type Phase1Fixture = { input: NewGameInput; seed: string };
const FIXTURE = wuxiaFixture as unknown as Phase1Fixture;

const TMP_ROOT = resolve("tmp");
const RUN_PREFIX = "sqlite-api-create-";
try {
  for (const entry of readdirSync(TMP_ROOT)) {
    if (entry.startsWith(RUN_PREFIX)) {
      try {
        rmSync(join(TMP_ROOT, entry), { recursive: true, force: true });
      } catch {
        /* 仍被占用：忽略 */
      }
    }
  }
} catch {
  /* tmp/ 尚不存在 */
}
const RUN_ROOT = join(TMP_ROOT, `${RUN_PREFIX}${Date.now()}-${process.pid}`);
mkdirSync(RUN_ROOT, { recursive: true });

let fileCounter = 0;
function nextDbPath(): string {
  fileCounter += 1;
  return join(RUN_ROOT, `case-${fileCounter}.sqlite`);
}

const openedEntryPoints: ServerGameEntryPoints[] = [];

function openEntryPoints(databasePath: string): ServerGameEntryPoints {
  const entryPoints = createServerGameEntryPoints({
    GAME_DB_PATH: databasePath,
    GAME_LOG_DB_PATH: `${databasePath}.logs.db`
  });
  openedEntryPoints.push(entryPoints);
  return entryPoints;
}

function openDevelopmentEntryPoints(databasePath: string): ServerGameEntryPoints {
  const entryPoints = createServerGameEntryPoints({
    GAME_DB_PATH: databasePath,
    GAME_LOG_DB_PATH: `${databasePath}.logs.db`,
    NODE_ENV: "development"
  });
  openedEntryPoints.push(entryPoints);
  return entryPoints;
}

afterAll(async () => {
  for (const entryPoints of openedEntryPoints) {
    try {
      await entryPoints.close();
    } catch {
      /* 已关闭 */
    }
  }
  try {
    rmSync(RUN_ROOT, { recursive: true, force: true });
  } catch {
    /* Windows 句柄未释放时留待下次运行清理 */
  }
});

function postRequest(body: string): Request {
  return new Request("http://localhost/api/game", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body
  });
}

function postJson(payload: unknown): Request {
  return postRequest(JSON.stringify(payload));
}

describe("handleCreateGameRequest：合法开局资料", () => {
  it("有效 body ⇒ 201 + opening view，current API 恢复同一开场", async () => {
    const databasePath = nextDbPath();
    const entryPoints = openEntryPoints(databasePath);

    const response = await handleCreateGameRequest(postJson(FIXTURE.input), entryPoints);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.view.player.name).toBe(FIXTURE.input.characterName);
    expect(body.view.world.gameType).toBe("wuxia");
    expect(body.view.openingNarration).not.toBe("");
    // Phase 4A：成功 body 只含 view + 安全来源字段。生产组合根注入 unavailable
    // source，玩家路径必然走稳定模板 ⇒ generationSource 恒为 "fallback"。
    expect(Object.keys(body).sort()).toEqual(["generationSource", "view"]);
    expect(body.generationSource).toBe("fallback");

    // 「刷新恢复」的 API 层证明：current handler 返回完全相同的 view，
    // 且不携带 generationSource——降级提示只属于创建那一次。
    const current = await handleCurrentGameRequest(entryPoints);
    expect(current.status).toBe(200);
    expect(await current.json()).toEqual({ status: "active", view: body.view });
  });

  it("浏览器提交 gameLength 时长字段 ⇒ 201（属于开局资料允许字段）", async () => {
    const databasePath = nextDbPath();
    const entryPoints = openEntryPoints(databasePath);
    const withLength = { ...FIXTURE.input, gameLength: "long" };
    const response = await handleCreateGameRequest(postJson(withLength), entryPoints);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.view.world.gameType).toBe("wuxia");
  });

  it("响应绝不携带 seed/blueprint/state/inputDigest 等内部信息", async () => {
    const entryPoints = openEntryPoints(nextDbPath());
    const response = await handleCreateGameRequest(postJson(FIXTURE.input), entryPoints);
    const text = await response.text();
    // Phase 4A 追加：候选生成的内部诊断（diagnostics/fixtureId/origin/traceId）
    // 同样只属于内部记录，绝不进入玩家响应。
    // Phase 7：worldMap.nodes[].state 是安全的 UI 显示状态字段，不属内部 GameState；
    // 改用 state_json/stateVersion/eventLedger 等真正的内部字段名检测泄漏。
    for (const secret of [
      '"seed"',
      '"blueprint"',
      '"state_json"',
      '"stateVersion"',
      '"eventLedger"',
      '"inputDigest"',
      '"diagnostics"',
      '"fixtureId"',
      '"origin"',
      '"traceId"'
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("handleCreateGameRequest：开发离线旅程开局", () => {
  it("专用 marker ⇒ 201 固定基线；不会要求或接受浏览器输入", async () => {
    const entryPoints = openDevelopmentEntryPoints(nextDbPath());
    const response = await handleCreateGameRequest(
      postJson({ developmentPreset: "phase10-journey-v1" }),
      entryPoints,
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.view.world.gameType).toBe("wuxia");
    expect(body.view.narrative).toBeNull();
    expect(body.view.narrativeGeneration).toEqual({ status: "ready" });
  });

  it("生产入口或缺少开发能力时拒绝 preset", async () => {
    const response = await handleCreateGameRequest(
      postJson({ developmentPreset: "phase10-journey-v1" }),
      { createGame: vi.fn() },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "DEVELOPMENT_TOOLS_DISABLED" });
  });

  it("preset + 合法 caseId ⇒ 201 该题材基线", async () => {
    const entryPoints = openDevelopmentEntryPoints(nextDbPath());
    const response = await handleCreateGameRequest(
      postJson({ developmentPreset: "phase10-journey-v1", caseId: "post-apocalypse-a" }),
      entryPoints,
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.view.world.gameType).toBe("post_apocalypse");
  });

  it("preset + 未知 caseId ⇒ 400 UNEXPECTED_FIELDS[caseId] 且不创建", async () => {
    const databasePath = nextDbPath();
    const entryPoints = openDevelopmentEntryPoints(databasePath);
    const response = await handleCreateGameRequest(
      postJson({ developmentPreset: "phase10-journey-v1", caseId: "unknown" }),
      entryPoints,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "UNEXPECTED_FIELDS", fields: ["caseId"] });
  });

  it("preset + caseId 类型错误 ⇒ 400 INVALID_FIELD_TYPES[caseId]", async () => {
    const entryPoints = openDevelopmentEntryPoints(nextDbPath());
    const response = await handleCreateGameRequest(
      postJson({ developmentPreset: "phase10-journey-v1", caseId: 42 }),
      entryPoints,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_FIELD_TYPES", fields: ["caseId"] });
  });

  it("preset + 白名单外其他字段 ⇒ 400 UNEXPECTED_FIELDS", async () => {
    const entryPoints = openDevelopmentEntryPoints(nextDbPath());
    const response = await handleCreateGameRequest(
      postJson({ developmentPreset: "phase10-journey-v1", caseId: "wuxia-a", evil: 1 }),
      entryPoints,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { fields?: string[] };
    expect(body.fields).toContain("evil");
  });
});

describe("handleCreateGameRequest：adapter 层拒收", () => {
  it("浏览器无法伪造 seed/gameId/生成来源/state ⇒ 400 UNEXPECTED_FIELDS 且零写入", async () => {
    const databasePath = nextDbPath();
    const entryPoints = openEntryPoints(databasePath);
    const forged = {
      ...FIXTURE.input,
      seed: "attacker-seed",
      gameId: "attacker-id",
      source: "ai",
      state: { hp: 9999 }
    };

    const response = await handleCreateGameRequest(postJson(forged), entryPoints);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("UNEXPECTED_FIELDS");
    expect(body.fields).toEqual(["gameId", "seed", "source", "state"]);
    // facade 未被触及：连数据库文件都不创建。
    expect(existsSync(databasePath)).toBe(false);
  });

  it("不合法 JSON ⇒ 400 MALFORMED_JSON", async () => {
    const entryPoints = openEntryPoints(nextDbPath());
    const response = await handleCreateGameRequest(postRequest("{not-json"), entryPoints);
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("MALFORMED_JSON");
  });

  it("JSON 非对象（数组）⇒ 400 MALFORMED_JSON", async () => {
    const entryPoints = openEntryPoints(nextDbPath());
    const response = await handleCreateGameRequest(postJson([FIXTURE.input]), entryPoints);
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("MALFORMED_JSON");
  });

  it("已知字段类型错误 ⇒ 400 INVALID_FIELD_TYPES 并列出字段", async () => {
    const entryPoints = openEntryPoints(nextDbPath());
    const wrongTypes = { ...FIXTURE.input, characterName: 42, personalityTags: "坚毅" };
    const response = await handleCreateGameRequest(postJson(wrongTypes), entryPoints);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("INVALID_FIELD_TYPES");
    expect(body.fields).toEqual(["characterName", "personalityTags"]);
  });

  it("缺失必填字段走 domain 校验 ⇒ 400 INVALID_INPUT + fieldErrors，零写入", async () => {
    const databasePath = nextDbPath();
    const entryPoints = openEntryPoints(databasePath);
    const { characterName: _dropped, ...withoutName } = FIXTURE.input;
    void _dropped;

    const response = await handleCreateGameRequest(postJson(withoutName), entryPoints);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("INVALID_INPUT");
    expect(body.fieldErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "characterName", code: "REQUIRED" })])
    );
    expect(existsSync(databasePath)).toBe(false);
  });
});

describe("handleCreateGameRequest：facade 结果映射", () => {
  it("已有当前存档 ⇒ 409 ACTIVE_GAME_EXISTS", async () => {
    const entryPoints = openEntryPoints(nextDbPath());
    const first = await handleCreateGameRequest(postJson(FIXTURE.input), entryPoints);
    expect(first.status).toBe(201);

    const second = await handleCreateGameRequest(postJson(FIXTURE.input), entryPoints);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ code: "ACTIVE_GAME_EXISTS" });
  });

  it("GENERATION_INVALID ⇒ 422，INFRASTRUCTURE_FAILURE ⇒ 503", async () => {
    for (const [code, status] of [
      ["GENERATION_INVALID", 422],
      ["INFRASTRUCTURE_FAILURE", 503]
    ] as const) {
      const stub: Pick<ServerGameEntryPoints, "createGame"> = {
        createGame: vi.fn(async () => ({ ok: false as const, code }))
      };
      const response = await handleCreateGameRequest(postJson(FIXTURE.input), stub);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ code });
    }
  });

  it("facade 意外抛错 ⇒ 500 INTERNAL_ERROR，异常文本不外泄", async () => {
    const stub: Pick<ServerGameEntryPoints, "createGame"> = {
      createGame: vi.fn(async () => {
        throw new Error("secret sql detail");
      })
    };
    const response = await handleCreateGameRequest(postJson(FIXTURE.input), stub);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ code: "INTERNAL_ERROR" });
    expect(text).not.toContain("secret sql detail");
  });
});

describe("route.ts 薄壳接线", () => {
  it("导出 POST route handler（不在测试中调用生产单例）", async () => {
    const routeModule = await import("./route");
    expect(typeof routeModule.POST).toBe("function");
  });
});
