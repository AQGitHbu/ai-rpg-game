/** @vitest-environment node */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerGameEntryPoints, resolveStoryEvalAssembly } from "./compositionRoot";
import wuxiaFixture from "../../../../data/fixtures/phase1/wuxia.json";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ }
  }
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "composition-story-eval-"));
  dirs.push(dir);
  return dir;
}

const validAiEnv = {
  AI_API_BASE_URL: "http://127.0.0.1:9/v1",
  AI_MODEL: "test-model",
  AI_API_KEY: "test-key",
  // createOfflineJourneyGame 首行检查 NODE_ENV !== "development" 即返回
  // DEVELOPMENT_TOOLS_DISABLED（compositionRoot 现状），测试 1 必须显式置 development。
  NODE_ENV: "development",
};

const fixture = wuxiaFixture as unknown as { input: { gameType: string; characterName: string; characterIdentity: string; personalityTags: string[]; worldPremise: string; storyOpening: string; narrativeStyle: string; contentIntensity: string } };

describe("resolveStoryEvalAssembly", () => {
  it("STORY_EVAL_CAPTURE 未设置时返回全 undefined（零装配）", () => {
    const assembly = resolveStoryEvalAssembly({});
    expect(assembly.captureSink).toBeUndefined();
    expect(assembly.approvalObserver).toBeUndefined();
  });
  it("STORY_EVAL_CAPTURE=1 且给目录时装配 sink 与 observer", () => {
    const dir = tempDir();
    const assembly = resolveStoryEvalAssembly({ STORY_EVAL_CAPTURE: "1", STORY_EVAL_ARTIFACT_DIR: dir });
    expect(assembly.captureSink).toBeDefined();
    expect(assembly.approvalObserver).toBeDefined();
  });
});

describe("createServerGameEntryPoints 采集装配", () => {
  it("STORY_EVAL_CAPTURE 未设置时不产生任何文件（行为与现状一致）", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "no-capture.sqlite");
    const entry = createServerGameEntryPoints({ ...validAiEnv, GAME_DB_PATH: dbPath });
    try {
      const result = await entry.createOfflineJourneyGame();
      expect(result.ok).toBe(true);
      expect(existsSync(dir)).toBe(true);
    } finally {
      await entry.close();
    }
    // 无 STORY_EVAL_ARTIFACT_DIR 指向时不应产生 story-eval 目录
    const storyEvalDirs = readdirSync(dir).filter((name) => name.startsWith("story-eval"));
    expect(storyEvalDirs).toEqual([]);
  });

  it("STORY_EVAL_CAPTURE=1 时 createGame 把 scenario 调用写入 calls.jsonl", async () => {
    const dir = tempDir();
    const artifactDir = join(dir, "story-eval", "run-test");
    const dbPath = join(dir, "capture.sqlite");
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        world: { name: "W", summary: "S", tone: "dark", themes: ["t"], facts: [] },
        openingScene: {}, player: {},
        locations: [], npcs: [], quests: [], items: [], enemies: [], endings: [],
      }) } }] }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy);
    let entry;
    try {
      entry = createServerGameEntryPoints({
        ...validAiEnv,
        GAME_DB_PATH: dbPath,
        STORY_EVAL_CAPTURE: "1",
        STORY_EVAL_ARTIFACT_DIR: artifactDir,
      });
      const result = await entry.createGame(fixture.input as never);
      expect(result.ok).toBe(true);
    } finally {
      vi.restoreAllMocks();
      await entry?.close();
    }
    const lines = readFileSync(join(artifactDir, "calls.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    const first = JSON.parse(lines[0]);
    expect(first.kind).toBe("ai_call");
    expect(first.role).toBe("scenario");
  });
});
