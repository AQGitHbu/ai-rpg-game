/** @vitest-environment node */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { NewGameInput } from "@/game/application";
import {
  createServerGameEntryPoints,
  type ServerGameEntryPoints
} from "@/game/application/server/compositionRoot";
import wuxiaFixture from "../../../../../data/fixtures/phase1/wuxia.json";
import { handleCurrentGameRequest } from "./currentGameHandler";

// ---------------------------------------------------------------------------
// Task 4：GET /api/game/current adapter 测试。
// none / active 走真实组合根 + tmp/ SQLite；corrupt 各 reason 与异常兜底走
// 结构化 stub。响应绝不携带 blueprint/state 原始 JSON。
// ---------------------------------------------------------------------------

type Phase1Fixture = { input: NewGameInput; seed: string };
const FIXTURE = wuxiaFixture as unknown as Phase1Fixture;

const TMP_ROOT = resolve("tmp");
const RUN_PREFIX = "sqlite-api-current-";
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
const openedEntryPoints: ServerGameEntryPoints[] = [];

function openEntryPoints(): ServerGameEntryPoints {
  fileCounter += 1;
  const entryPoints = createServerGameEntryPoints({
    GAME_DB_PATH: join(RUN_ROOT, `case-${fileCounter}.sqlite`),
    GAME_LOG_DB_PATH: join(RUN_ROOT, `case-${fileCounter}.logs.db`)
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

describe("handleCurrentGameRequest", () => {
  it("开发入口显式公开开发工具可用性，但不公开其它环境信息", async () => {
    const response = await handleCurrentGameRequest({
      developmentToolsEnabled: true,
      getCurrentGame: async () => ({ status: "none" })
    });
    expect(await response.json()).toEqual({ status: "none", developmentTools: true });
  });

  it("无存档 ⇒ 200 { status: 'none' }", async () => {
    const entryPoints = openEntryPoints();
    const response = await handleCurrentGameRequest(entryPoints);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "none" });
  });

  it("有 active 存档 ⇒ 200 + 与创建一致的 view，且不含 blueprint/state JSON", async () => {
    const entryPoints = openEntryPoints();
    const created = await entryPoints.createGame(FIXTURE.input);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const response = await handleCurrentGameRequest(entryPoints);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ status: "active", view: created.view });
    for (const secret of ['"blueprint"', '"state_json"', '"stateVersion"', '"eventLedger"', '"seed"', '"inputDigest"']) {
      expect(text).not.toContain(secret);
    }
  });

  it("数据损坏 reason ⇒ 200 corrupt（reason 透传，可显示可恢复）", async () => {
    const stub: Pick<ServerGameEntryPoints, "getCurrentGame"> = {
      getCurrentGame: vi.fn(async () => ({
        status: "corrupt" as const,
        reason: "VERSION_MISMATCH" as const
      }))
    };
    const response = await handleCurrentGameRequest(stub);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "corrupt", reason: "VERSION_MISMATCH" });
  });

  it("基础设施失败 reason ⇒ 503 corrupt（客户端仍可读 body 分支文案）", async () => {
    const stub: Pick<ServerGameEntryPoints, "getCurrentGame"> = {
      getCurrentGame: vi.fn(async () => ({
        status: "corrupt" as const,
        reason: "INFRASTRUCTURE_FAILURE" as const
      }))
    };
    const response = await handleCurrentGameRequest(stub);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "corrupt",
      reason: "INFRASTRUCTURE_FAILURE"
    });
  });

  it("facade 意外抛错 ⇒ 503 corrupt INFRASTRUCTURE_FAILURE，异常文本不外泄", async () => {
    const stub: Pick<ServerGameEntryPoints, "getCurrentGame"> = {
      getCurrentGame: vi.fn(async () => {
        throw new Error("secret projection detail");
      })
    };
    const response = await handleCurrentGameRequest(stub);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ status: "corrupt", reason: "INFRASTRUCTURE_FAILURE" });
    expect(text).not.toContain("secret projection detail");
  });
});

describe("route.ts 薄壳接线", () => {
  it("导出 GET route handler（不在测试中调用生产单例）", async () => {
    const routeModule = await import("./route");
    expect(typeof routeModule.GET).toBe("function");
  });
});
