// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createTextAuditRecorder } from "./textAuditRecorder";
import type { AiTextAuditPayload } from "./textAuditTypes";

function readJsonLines(filePath: string): unknown[] {
  const text = require("node:fs").readFileSync(filePath, "utf8") as string;
  return text
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries;
}

const fixtureCall: AiTextAuditPayload = {
  kind: "ai_call",
  callId: "call-1",
  role: "scene",
  attempt: 1,
  context: {
    purpose: "scene_performance",
    trigger: "talk_choice",
    gameId: "game-1",
  },
  input: {
    messages: [{ role: "system", content: "完整 prompt" }],
  },
  output: { ok: true, content: "完整模型正文", latencyMs: 1 },
};

describe("createTextAuditRecorder", () => {
  let tempDir: string;

  async function makeTempDir(): Promise<string> {
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = path.join(os.tmpdir(), `audit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async function cleanup(dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  it("is enabled by default and creates a run directory on first record", async () => {
    tempDir = await makeTempDir();
    try {
      const recorder = createTextAuditRecorder({}, { rootDir: tempDir });
      expect(recorder.enabled).toBe(true);

      await recorder.record(fixtureCall);

      const runDirs = await readdir(tempDir);
      expect(runDirs).toHaveLength(1);

      const filesInRun = await listFiles(join(tempDir, runDirs[0]));
      expect(filesInRun).toContain("events.jsonl");

      await recorder.close();
    } finally {
      await cleanup(tempDir);
    }
  });

  it("derives runId from now() when AI_TEXT_AUDIT_RUN_ID is not set", async () => {
    tempDir = await makeTempDir();
    try {
      const recorder = createTextAuditRecorder(
        {},
        { rootDir: tempDir, now: () => "2026-08-20T00:00:00.000Z" },
      );

      await recorder.record(fixtureCall);
      await recorder.close();

      const runDirs = await readdir(tempDir);
      expect(runDirs).toHaveLength(1);
      // ISO timestamp with : replaced by -
      expect(runDirs[0]).toBe("2026-08-20T00-00-00.000Z");
    } finally {
      await cleanup(tempDir);
    }
  });

  it("is disabled when AI_TEXT_AUDIT=off and does not create new run directory", async () => {
    tempDir = await makeTempDir();
    try {
      // First, create one run directory with an enabled recorder
      const enabledRecorder = createTextAuditRecorder(
        { AI_TEXT_AUDIT_RUN_ID: "run-test" },
        { rootDir: tempDir },
      );
      await enabledRecorder.record(fixtureCall);
      await enabledRecorder.close();

      // Now create a disabled recorder
      const disabled = createTextAuditRecorder(
        { AI_TEXT_AUDIT: "off" },
        { rootDir: tempDir },
      );
      expect(disabled.enabled).toBe(false);

      await disabled.record(fixtureCall);
      await disabled.close();

      // Should still have only the one run directory from the enabled recorder
      const runDirs = await readdir(tempDir);
      expect(runDirs).toHaveLength(1);
    } finally {
      await cleanup(tempDir);
    }
  });

  it("treats AI_TEXT_AUDIT values other than 'off' as full", async () => {
    tempDir = await makeTempDir();
    try {
      for (const val of [undefined, "", "full", "debug", "random"]) {
        const recorder = createTextAuditRecorder(
          val === undefined ? {} : { AI_TEXT_AUDIT: val },
          { rootDir: tempDir, now: () => `2026-08-20T00:00:0${val?.length ?? 0}.000Z` },
        );
        expect(recorder.enabled).toBe(true);
        await recorder.close();
      }
    } finally {
      await cleanup(tempDir);
    }
  });

  it("writes full ai_call payload with messages and model content", async () => {
    tempDir = await makeTempDir();
    try {
      const full = createTextAuditRecorder(
        { AI_TEXT_AUDIT: "full", AI_TEXT_AUDIT_RUN_ID: "run-test" },
        { rootDir: tempDir, now: () => "2026-08-20T00:00:00.000Z" },
      );

      await full.record({
        kind: "ai_call",
        callId: "call-1",
        role: "scene",
        attempt: 1,
        context: {
          purpose: "scene_performance",
          trigger: "talk_choice",
          gameId: "game-1",
        },
        input: {
          messages: [{ role: "system", content: "完整 prompt" }],
        },
        output: { ok: true, content: "完整模型正文", latencyMs: 1 },
      });
      await full.close();

      const rows = readJsonLines(join(tempDir, "run-test", "events.jsonl")) as Array<Record<string, unknown>>;
      expect(rows[0]).toMatchObject({
        kind: "ai_call",
        input: { messages: [{ content: "完整 prompt" }] },
      });
      expect(rows[0]).toMatchObject({ output: { content: "完整模型正文" } });
      // Envelope fields
      expect(rows[0]).toHaveProperty("sequence");
      expect(rows[0]).toHaveProperty("timestamp");
      expect(typeof rows[0]["sequence"]).toBe("number");
      expect(rows[0]["sequence"]).toBe(1);
      expect(rows[0]["timestamp"]).toBe("2026-08-20T00:00:00.000Z");
    } finally {
      await cleanup(tempDir);
    }
  });

  it("does not truncate content exceeding 131072 bytes (no 128 KiB limit)", async () => {
    tempDir = await makeTempDir();
    try {
      const largeContent = "x".repeat(200_000);
      const recorder = createTextAuditRecorder(
        { AI_TEXT_AUDIT_RUN_ID: "run-large" },
        { rootDir: tempDir },
      );

      await recorder.record({
        kind: "ai_call",
        callId: "call-large",
        role: "opening",
        attempt: 1,
        context: { purpose: "opening_generation", trigger: "new_game", gameId: "g1" },
        input: { messages: [{ role: "system", content: largeContent }] },
        output: { ok: true, content: largeContent, latencyMs: 1 },
      });
      await recorder.close();

      const rows = readJsonLines(join(tempDir, "run-large", "events.jsonl")) as Array<Record<string, unknown>>;
      const output = rows[0]["output"] as { content: string };
      expect(output.content.length).toBe(200_000);
    } finally {
      await cleanup(tempDir);
    }
  });

  it("record() resolves without throwing on write failure and calls onWriteFailure", async () => {
    tempDir = await makeTempDir();
    try {
      let failureCalled = false;
      const recorder = createTextAuditRecorder(
        { AI_TEXT_AUDIT_RUN_ID: "run-fail" },
        {
          rootDir: tempDir,
          onWriteFailure: () => { failureCalled = true; },
        },
      );

      // Sabotage by pointing rootDir to a non-creatable path after first record creates the dir
      // We'll use a rootDir that is a file, not a directory
      const fileAsDir = join(tempDir, "iamfile");
      const fs = await import("node:fs/promises");
      await fs.writeFile(fileAsDir, "not a directory");

      const badRecorder = createTextAuditRecorder(
        { AI_TEXT_AUDIT_RUN_ID: "run-bad" },
        {
          rootDir: fileAsDir,
          onWriteFailure: () => { failureCalled = true; },
        },
      );

      // Should resolve, not throw
      await expect(badRecorder.record(fixtureCall)).resolves.toBeUndefined();
      expect(failureCalled).toBe(true);
      await badRecorder.close();
    } finally {
      await cleanup(tempDir);
    }
  });

  it("calls onConfigIssue for invalid runId containing path separators", async () => {
    tempDir = await makeTempDir();
    try {
      let configIssueCode: string | undefined;
      const recorder = createTextAuditRecorder(
        { AI_TEXT_AUDIT_RUN_ID: "../escape" },
        {
          rootDir: tempDir,
          now: () => "2026-08-20T00:00:00.000Z",
          onConfigIssue: (code) => { configIssueCode = code; },
        },
      );

      await recorder.record(fixtureCall);
      await recorder.close();

      expect(configIssueCode).toBe("invalid_run_id");
      // Should have used an auto-derived runId instead
      const runDirs = await readdir(tempDir);
      expect(runDirs).toHaveLength(1);
      expect(runDirs[0]).not.toBe("..");
    } finally {
      await cleanup(tempDir);
    }
  });

  it("serializes concurrent records with incrementing sequence", async () => {
    tempDir = await makeTempDir();
    try {
      const recorder = createTextAuditRecorder(
        { AI_TEXT_AUDIT_RUN_ID: "run-concurrent" },
        { rootDir: tempDir, now: () => "2026-08-20T00:00:00.000Z" },
      );

      const promises: Promise<void>[] = [];
      for (let i = 0; i < 10; i++) {
        promises.push(recorder.record({
          ...fixtureCall,
          callId: `call-${i}`,
        }));
      }
      await Promise.all(promises);
      await recorder.close();

      const rows = readJsonLines(join(tempDir, "run-concurrent", "events.jsonl")) as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(10);
      for (let i = 0; i < 10; i++) {
        expect(rows[i]["sequence"]).toBe(i + 1);
      }
    } finally {
      await cleanup(tempDir);
    }
  });

  it("writes game_api payload with route, method, request and response", async () => {
    tempDir = await makeTempDir();
    try {
      const recorder = createTextAuditRecorder(
        { AI_TEXT_AUDIT_RUN_ID: "run-api" },
        { rootDir: tempDir },
      );

      await recorder.record({
        kind: "game_api",
        route: "/api/game",
        method: "POST",
        context: {
          purpose: "game_api",
          trigger: "create_game",
          traceId: "trace-1",
        },
        request: { rawBody: '{"gameType":"a"}', json: { gameType: "a" } },
        response: { rawBody: '{"ok":true}', json: { ok: true } },
        httpStatus: 200,
      });
      await recorder.close();

      const rows = readJsonLines(join(tempDir, "run-api", "events.jsonl")) as Array<Record<string, unknown>>;
      expect(rows[0]).toMatchObject({
        kind: "game_api",
        route: "/api/game",
        method: "POST",
        httpStatus: 200,
      });
    } finally {
      await cleanup(tempDir);
    }
  });

  it("writes story_text payload with visible text", async () => {
    tempDir = await makeTempDir();
    try {
      const recorder = createTextAuditRecorder(
        { AI_TEXT_AUDIT_RUN_ID: "run-story" },
        { rootDir: tempDir },
      );

      await recorder.record({
        kind: "story_text",
        context: {
          purpose: "final_story_text",
          trigger: "talk_choice",
          gameId: "g1",
          jobId: "j1",
          revision: 3,
        },
        source: "generated",
        path: "normal",
        visibleText: { narration: "场景叙述" },
      });
      await recorder.close();

      const rows = readJsonLines(join(tempDir, "run-story", "events.jsonl")) as Array<Record<string, unknown>>;
      expect(rows[0]).toMatchObject({
        kind: "story_text",
        source: "generated",
        path: "normal",
        visibleText: { narration: "场景叙述" },
      });
    } finally {
      await cleanup(tempDir);
    }
  });

  it("close() resolves even on failure and swallows close exceptions", async () => {
    tempDir = await makeTempDir();
    try {
      const recorder = createTextAuditRecorder(
        { AI_TEXT_AUDIT_RUN_ID: "run-close" },
        { rootDir: tempDir },
      );
      await recorder.record(fixtureCall);
      // close twice - second should not throw
      await recorder.close();
      await expect(recorder.close()).resolves.toBeUndefined();
    } finally {
      await cleanup(tempDir);
    }
  });

  it("does not create directories or files before first record when enabled", async () => {
    tempDir = await makeTempDir();
    try {
      const recorder = createTextAuditRecorder(
        { AI_TEXT_AUDIT_RUN_ID: "run-empty" },
        { rootDir: tempDir },
      );
      expect(recorder.enabled).toBe(true);
      // No directory should exist yet
      const entries = await readdir(tempDir);
      expect(entries).toHaveLength(0);
      await recorder.close();
      // Still empty after close without record
      const entriesAfter = await readdir(tempDir);
      expect(entriesAfter).toHaveLength(0);
    } finally {
      await cleanup(tempDir);
    }
  });
});
