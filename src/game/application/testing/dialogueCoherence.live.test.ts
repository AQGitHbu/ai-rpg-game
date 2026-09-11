// @vitest-environment node
import { expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createSqliteClient } from "../server/persistence/sqliteClient";
import { createServerGameEntryPoints } from "../server/compositionRoot";
import type { GameSessionView } from "../gameSessionView";

/** Explicit local regression: all writes target a fresh copy, never the source save. */
it.skipIf(process.env.RUN_REAL_AI_COHERENCE !== "1")("真实 API：存档副本重放首轮并连续完成三次对白选择", async () => {
  const sourcePath = resolve(process.env.COHERENCE_SOURCE_DB ?? "db/rpg.sqlite");
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const originalDigest = digest(await readFile(sourcePath));
  const root = resolve("tmp", `planner-content-dialogue-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const databasePath = resolve(root, "game.sqlite");
  await copyFile(sourcePath, databasePath);
  // Recover the captured pre-generation snapshot in the COPY, so the first
  // regression repeats the user's question instead of starting after its answer.
  const db = createSqliteClient(databasePath);
  try {
    const jobs = await db.execute("SELECT payload_json FROM narrative_jobs WHERE scope='decision' ORDER BY rowid DESC LIMIT 1");
    const job = jobs.rows[0] === undefined ? null : JSON.parse(String(jobs.rows[0].payload_json));
    if (job?.input?.kind !== "decision") throw Error("COHERENCE_DECISION_SNAPSHOT_MISSING");
    // Extend only the isolated test conversation before unrelated act transitions.
    // World facts, authority and selected input remain the original save values.
    if (job.input.story.narrative.dialogueSession) {
      job.input.story.narrative.dialogueSession.requiredTurns = 8;
    }
    await db.batch([
      { sql: "UPDATE game_records SET world_state_json=?, story_state_json=?, revision=? WHERE game_id=?",
        args: [JSON.stringify(job.input.world), JSON.stringify(job.input.story), job.baseRevision, job.gameId] },
      "DELETE FROM initialization_slot", "DELETE FROM narrative_jobs",
    ], "write");
  } finally { db.close(); }
  // @ts-expect-error repository ESM script has no TypeScript declaration.
  const { readAiEnv } = await import("../../../../scripts/aiEnv.mjs");
  const config = readAiEnv(resolve(".env.local")) as Map<string, { decoded: string }>;
  const env = { ...Object.fromEntries([...config].map(([key, value]) => [key, value.decoded])),
    ...(process.env.COHERENCE_PLANNER_THINKING === "1" ? { AI_RUNTIME_THINKING_ROLES: "planning" } : {}),
    GAME_DB_PATH: databasePath, GAME_LOG_DB_PATH: resolve(root, "logs.sqlite"),
    AI_TEXT_AUDIT: "full", GAME_API_AUDIT: "compact", AI_TEXT_AUDIT_DIR: root, AI_TEXT_AUDIT_RUN_ID: "audit" };
  const entry = createServerGameEntryPoints(env);
  const originalFetch = globalThis.fetch;
  const deadline = Date.now() + 15 * 60_000;
  let providerRequests = 0;
  globalThis.fetch = async (input, init = {}) => {
    if (++providerRequests > 100 || Date.now() >= deadline) throw Error("COHERENCE_BUDGET_EXCEEDED");
    const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    return originalFetch(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal });
  };
  const exchanges: unknown[] = [];
  const record = async () => writeFile(resolve(root, "result.json"), JSON.stringify({ providerRequests,
    plannerThinkingOverride: process.env.COHERENCE_PLANNER_THINKING === "1", exchanges }, null, 2));
  const choices = (view: GameSessionView) => view.narrative.npcDialogues.find(npc => npc.choices.length === 2)?.choices
    ?? view.narrative.choices;
  async function settled() {
    while (Date.now() < deadline) {
      const current = await entry.getCurrentGame();
      if (!current.ok || !current.view || current.revision === undefined) throw Error("COHERENCE_CURRENT_UNAVAILABLE");
      if (current.view.narrativeGeneration.status === "failed") {
        exchanges.push({ failure: current }); await record(); throw Error("COHERENCE_GENERATION_FAILED");
      }
      if (current.view.narrativeGeneration.status !== "pending") return { view: current.view, revision: current.revision };
      await new Promise(resolve => setTimeout(resolve, 700));
    }
    throw Error("COHERENCE_TIMEOUT");
  }
  async function submit(choiceToken: string, revision: number) {
    const command = { actionId: randomUUID(), interaction: { kind: "fixed_choice" as const, choiceToken }, expectedRevision: revision };
    const response = await entry.executeHttpRequest("POST", "/api/game/actions", async ({ traceId }) =>
      Response.json(await entry.performTurn(command, traceId)), undefined,
    new Request("http://localhost/api/game/actions", { method: "POST", body: JSON.stringify(command) }));
    const result = await response.json();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    await entry.ensureNarrativeScene();
    return settled();
  }
  try {
    await entry.ensureNarrativeScene();
    let current = await settled();
    exchanges.push({ kind: "replayed_user_question", after: current }); await record();
    for (let round = 1; round <= 3; round++) {
      // Rule movement/hand-offs consume published steps and are not counted as
      // dialogue turns. Follow only server-issued tokens, never invented actions.
      for (let step = 0; choices(current.view).length !== 2 && step < 12; step++) {
        const token = current.view.story.currentObjectiveChoiceTokens?.[0]
          ?? current.view.currentLocation.actions[0]?.choiceToken;
        if (!token) throw Error("COHERENCE_DIALOGUE_UNREACHABLE");
        const before = current;
        current = await submit(token, current.revision);
        exchanges.push({ kind: "rule_progress", before, after: current }); await record();
      }
      const options = choices(current.view);
      expect(options.length).toBe(2);
      // Exercise fresh inquiries first, then the contrasting stance option.
      const choice = options[round === 2 ? 1 : 0]!;
      const before = current;
      current = await submit(choice.choiceToken, current.revision);
      exchanges.push({ kind: "dialogue", round, selected: choice.label, before, after: current }); await record();
      expect(current.revision).toBeGreaterThan(before.revision);
      expect(current.view.narrative.hasScene).toBe(true);
    }
    expect(exchanges.filter(e => (e as { kind: string }).kind === "dialogue")).toHaveLength(3);
  } finally {
    await entry.close();
    globalThis.fetch = originalFetch;
    await record();
    expect(digest(await readFile(sourcePath)), "source save must be unchanged").toBe(originalDigest);
  }
}, 930_000);
