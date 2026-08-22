// @ts-check
//
// Node native test for the AI text audit CLI.
// Validates list/query/verify/export commands against synthetic JSONL runs.
// Run: node --test scripts/aiTextAudit.node-test.mjs

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const SCRIPT_PATH = join(process.cwd(), "scripts", "aiTextAudit.mjs");

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Build a synthetic audit run with all event kinds and all four AI roles.
 */
async function buildSyntheticRun(rootDir, runId = "test-run") {
  const runDir = join(rootDir, runId);
  await mkdir(runDir, { recursive: true });
  const events = [];

  // ai_call events: opening, intent, world, scene
  const roles = [
    { role: "opening", purpose: "opening_generation", trigger: "new_game" },
    { role: "intent", purpose: "intent_parsing", trigger: "free_text_action" },
    { role: "world", purpose: "world_evolution", trigger: "scene_evolution" },
    { role: "scene", purpose: "scene_performance", trigger: "talk_choice" },
  ];
  let seq = 1;
  for (const { role, purpose, trigger } of roles) {
    events.push({
      sequence: seq++,
      timestamp: `2026-08-20T00:00:0${seq - 1}.000Z`,
      kind: "ai_call",
      callId: `call-${role}`,
      role,
      attempt: 1,
      context: {
        purpose,
        trigger,
        gameId: "game-1",
        traceId: "trace-1",
      },
      input: {
        messages: [{ role: "system", content: `prompt for ${role}` }],
      },
      output: { ok: true, content: `model output for ${role}`, latencyMs: 100 },
    });
  }

  // game_api event
  events.push({
    sequence: seq++,
    timestamp: `2026-08-20T00:00:0${seq - 1}.000Z`,
    kind: "game_api",
    detail: "full",
    route: "/api/game",
    method: "POST",
    context: { purpose: "game_api", trigger: "create_game", traceId: "trace-1" },
    request: { rawBody: '{"gameType":"wuxia"}', json: { gameType: "wuxia" } },
    response: { rawBody: '{"ok":true}', json: { ok: true } },
    httpStatus: 200,
    durationMs: 12,
  });

  // story_text event
  events.push({
    sequence: seq++,
    timestamp: `2026-08-20T00:00:0${seq - 1}.000Z`,
    kind: "story_text",
    context: {
      purpose: "final_story_text",
      trigger: "initial_opening",
      gameId: "game-1",
      jobId: "job-1",
      actionId: "start_1",
      turnNumber: 1,
      revision: 2,
    },
    source: "generated",
    path: "normal",
    visibleText: { narration: "Opening narration text" },
  });

  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(join(runDir, "events.jsonl"), lines, "utf8");
  return runDir;
}

/**
 * Build a run with a sequence gap (missing sequence 2).
 */
async function buildGapRun(rootDir, runId = "gap-run") {
  const runDir = join(rootDir, runId);
  await mkdir(runDir, { recursive: true });
  const events = [
    { sequence: 1, timestamp: "2026-08-20T00:00:00.000Z", kind: "ai_call", callId: "c1", role: "scene", attempt: 1, context: { purpose: "scene_performance", trigger: "talk_choice" }, input: { messages: [] }, output: { ok: true, content: "a", latencyMs: 1 } },
    // sequence 2 is missing
    { sequence: 3, timestamp: "2026-08-20T00:00:02.000Z", kind: "ai_call", callId: "c3", role: "scene", attempt: 1, context: { purpose: "scene_performance", trigger: "talk_choice" }, input: { messages: [] }, output: { ok: true, content: "b", latencyMs: 1 } },
  ];
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(join(runDir, "events.jsonl"), lines, "utf8");
  return runDir;
}

/**
 * Build a run with a secret field (apiKey).
 */
async function buildSecretRun(rootDir, runId = "secret-run") {
  const runDir = join(rootDir, runId);
  await mkdir(runDir, { recursive: true });
  const events = [
    { sequence: 1, timestamp: "2026-08-20T00:00:00.000Z", kind: "ai_call", callId: "c1", role: "scene", attempt: 1, context: { purpose: "scene_performance", trigger: "talk_choice" }, input: { messages: [], apiKey: "sk-secret123" }, output: { ok: true, content: "a", latencyMs: 1 } },
  ];
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(join(runDir, "events.jsonl"), lines, "utf8");
  return runDir;
}

/**
 * Build a legacy run whose ai_call events carry only the old `repair`
 * field (no `retry`). Used to prove CLI read-only normalization keeps
 * historical logs valid.
 */
async function buildLegacyRepairRun(rootDir, runId = "legacy-repair-run") {
  const runDir = join(rootDir, runId);
  await mkdir(runDir, { recursive: true });
  const events = [
    {
      sequence: 1,
      timestamp: "2026-08-20T00:00:00.000Z",
      kind: "ai_call",
      callId: "c1",
      role: "scene",
      attempt: 1,
      context: {
        purpose: "scene_performance",
        trigger: "talk_choice",
        gameId: "game-1",
        repair: { attempt: 1, reason: "invalid_json" },
      },
      input: { messages: [] },
      output: { ok: true, content: "a", latencyMs: 1 },
    },
  ];
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(join(runDir, "events.jsonl"), lines, "utf8");
  return runDir;
}

/**
 * Build a run with malformed JSON.
 */
async function buildBadJsonRun(rootDir, runId = "badjson-run") {
  const runDir = join(rootDir, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "events.jsonl"), '{"valid":true}\n{bad json}\n', "utf8");
  return runDir;
}

// ---------------------------------------------------------------------------
// Helpers to run the CLI
// ---------------------------------------------------------------------------

function runCli(args, env = {}) {
  const fullEnv = { ...process.env, ...env };
  try {
    const output = execFileSync("node", [SCRIPT_PATH, ...args], {
      encoding: "utf8",
      env: fullEnv,
      cwd: process.cwd(),
    });
    return { stdout: output, stderr: "", status: 0 };
  } catch (err) {
    return {
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
      status: err.status ?? 1,
    };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("aiTextAudit CLI", () => {
  let tempRoot;

  before(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "audit-test-"));
  });

  after(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  describe("list", () => {
    it("lists available runs in the audit directory", async () => {
      await buildSyntheticRun(tempRoot, "list-run-1");
      await buildSyntheticRun(tempRoot, "list-run-2");

      const result = runCli(["list"], { AI_TEXT_AUDIT_DIR: tempRoot });
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.ok(result.stdout.includes("list-run-1"), `expected run-1 in output: ${result.stdout}`);
      assert.ok(result.stdout.includes("list-run-2"), `expected run-2 in output: ${result.stdout}`);
    });

    it("shows empty when no runs exist", async () => {
      const emptyDir = await mkdtemp(join(tmpdir(), "audit-empty-"));
      try {
        const result = runCli(["list"], { AI_TEXT_AUDIT_DIR: emptyDir });
        assert.equal(result.status, 0);
        assert.match(result.stdout, /no audit runs|no runs|empty/i);
      } finally {
        await rm(emptyDir, { recursive: true, force: true });
      }
    });
  });

  describe("query", () => {
    it("queries all events for a run", async () => {
      await buildSyntheticRun(tempRoot, "query-all");
      const result = runCli(["query", "--run", "query-all"], { AI_TEXT_AUDIT_DIR: tempRoot });
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      const lines = result.stdout.trim().split("\n").filter((l) => l.startsWith("{"));
      assert.equal(lines.length, 6, `expected 6 events, got ${lines.length}`);
    });

    it("queries by kind=ai_call", async () => {
      await buildSyntheticRun(tempRoot, "query-kind");
      const result = runCli(["query", "--run", "query-kind", "--kind", "ai_call"], { AI_TEXT_AUDIT_DIR: tempRoot });
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      const lines = result.stdout.trim().split("\n").filter((l) => l.startsWith("{"));
      assert.equal(lines.length, 4, `expected 4 ai_call events, got ${lines.length}`);
      for (const line of lines) {
        const entry = JSON.parse(line);
        assert.equal(entry.kind, "ai_call");
      }
    });

    it("queries by kind=game_api", async () => {
      await buildSyntheticRun(tempRoot, "query-api");
      const result = runCli(["query", "--run", "query-api", "--kind", "game_api"], { AI_TEXT_AUDIT_DIR: tempRoot });
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      const lines = result.stdout.trim().split("\n").filter((l) => l.startsWith("{"));
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.kind, "game_api");
      assert.equal(entry.route, "/api/game");
    });

    it("queries by kind=story_text", async () => {
      await buildSyntheticRun(tempRoot, "query-story");
      const result = runCli(["query", "--run", "query-story", "--kind", "story_text"], { AI_TEXT_AUDIT_DIR: tempRoot });
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      const lines = result.stdout.trim().split("\n").filter((l) => l.startsWith("{"));
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.kind, "story_text");
    });

    it("filters by gameId", async () => {
      await buildSyntheticRun(tempRoot, "query-game");
      const result = runCli(["query", "--run", "query-game", "--game", "game-1"], { AI_TEXT_AUDIT_DIR: tempRoot });
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      const lines = result.stdout.trim().split("\n").filter((l) => l.startsWith("{"));
      // All ai_call events have gameId=game-1, game_api has no gameId, story_text has gameId=game-1
      // ai_call: 4, story_text: 1 = 5 total (game_api has traceId but not gameId in context)
      assert.ok(lines.length >= 5, `expected at least 5 events with gameId, got ${lines.length}`);
      for (const line of lines) {
        const entry = JSON.parse(line);
        assert.equal(entry.context.gameId, "game-1");
      }
    });

    it("rejects path traversal in runId", async () => {
      const result = runCli(["query", "--run", "..\\outside"], { AI_TEXT_AUDIT_DIR: tempRoot });
      assert.notEqual(result.status, 0, "expected non-zero exit for unsafe runId");
      assert.match(result.stderr || result.stdout, /invalid.*run/i);
    });

    it("shows legacy repair as derived legend-unknown retry without rewriting JSONL", async () => {
      await buildLegacyRepairRun(tempRoot, "query-legacy");
      const result = runCli(["query", "--run", "query-legacy"], { AI_TEXT_AUDIT_DIR: tempRoot });
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      const lines = result.stdout.trim().split("\n").filter((l) => l.startsWith("{"));
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]);
      // Original raw event is untouched: only context.repair is present.
      assert.equal(entry.context.repair.attempt, 1);
      assert.equal(entry.context.repair.reason, "invalid_json");
      // Derived top-level retry field normalizes legacy repair for display.
      assert.equal(entry.retry.origin, "legacy_unknown");
      assert.equal(entry.retry.mechanism, "content_repair");
      assert.equal(entry.retry.attempt, 1);
      assert.equal(entry.retry.reason, "invalid_json");
      assert.equal(entry.context.retry, undefined);
    });
  });

  describe("verify", () => {
    it("verifies a clean run successfully", async () => {
      await buildSyntheticRun(tempRoot, "verify-clean");
      const result = runCli(["verify", "--run", "verify-clean"], { AI_TEXT_AUDIT_DIR: tempRoot });
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstderr: ${result.stderr}\nstdout: ${result.stdout}`);
    });

    it("fails on sequence gap", async () => {
      await buildGapRun(tempRoot, "verify-gap");
      const result = runCli(["verify", "--run", "verify-gap"], { AI_TEXT_AUDIT_DIR: tempRoot });
      assert.notEqual(result.status, 0, "expected non-zero exit for sequence gap");
      assert.match(result.stderr || result.stdout, /sequence|gap/i);
    });

    it("fails on malformed JSON", async () => {
      await buildBadJsonRun(tempRoot, "verify-badjson");
      const result = runCli(["verify", "--run", "verify-badjson"], { AI_TEXT_AUDIT_DIR: tempRoot });
      assert.notEqual(result.status, 0, "expected non-zero exit for bad JSON");
    });

    it("fails on secret fields (apiKey)", async () => {
      await buildSecretRun(tempRoot, "verify-secret");
      const result = runCli(["verify", "--run", "verify-secret"], { AI_TEXT_AUDIT_DIR: tempRoot });
      assert.notEqual(result.status, 0, "expected non-zero exit for secret field");
      assert.match(result.stderr || result.stdout, /apiKey|authorization|baseUrl|secret/i);
    });

    it("fails on missing required context fields", async () => {
      const runDir = join(tempRoot, "verify-missing");
      await mkdir(runDir, { recursive: true });
      // Missing context.purpose and context.trigger
      await writeFile(join(runDir, "events.jsonl"),
        JSON.stringify({ sequence: 1, timestamp: "2026-08-20T00:00:00.000Z", kind: "ai_call", callId: "c1", role: "scene", attempt: 1, context: {}, input: { messages: [] }, output: { ok: true, content: "a", latencyMs: 1 } }) + "\n",
        "utf8");
      const result = runCli(["verify", "--run", "verify-missing"], { AI_TEXT_AUDIT_DIR: tempRoot });
      assert.notEqual(result.status, 0, "expected non-zero exit for missing context");
    });

    it("accepts legacy repair-only events (no retry) as valid", async () => {
      await buildLegacyRepairRun(tempRoot, "verify-legacy-repair");
      const result = runCli(["verify", "--run", "verify-legacy-repair"], { AI_TEXT_AUDIT_DIR: tempRoot });
      assert.equal(result.status, 0, `expected exit 0 for legacy repair\nstderr: ${result.stderr}\nstdout: ${result.stdout}`);
    });
  });

  describe("export", () => {
    it("exports a run without modifying the original", async () => {
      await buildSyntheticRun(tempRoot, "export-test");
      const originalPath = join(tempRoot, "export-test", "events.jsonl");
      const originalContent = await readFile(originalPath, "utf8");

      const outFile = join(tempRoot, "exported.jsonl");
      const result = runCli(["export", "--run", "export-test", "--out", outFile], { AI_TEXT_AUDIT_DIR: tempRoot });
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);

      const exportedContent = await readFile(outFile, "utf8");
      assert.equal(exportedContent, originalContent, "exported content must match original");

      // Original must be unchanged
      const unchanged = await readFile(originalPath, "utf8");
      assert.equal(unchanged, originalContent, "original file must not be modified");
    });

    it("fails when run does not exist", async () => {
      const result = runCli(["export", "--run", "nonexistent", "--out", "/dev/null"], { AI_TEXT_AUDIT_DIR: tempRoot });
      assert.notEqual(result.status, 0, "expected non-zero exit for nonexistent run");
    });
  });
});
