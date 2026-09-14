import { existsSync, mkdirSync, writeFileSync, copyFileSync, constants } from "node:fs";
import { resolve } from "node:path";
import { createNarrativeP1ReplayRuntime, canonical, hashReplayValue } from "./narrativeP1Replay.mjs";
import { waitForNarrativeP1Generation, projectNarrativeP1GameSetup, hasCompletedCoreStory } from "./narrativeP1Journey.mjs";
import { selectProductionChoice, currentStoryInteractions } from "./narrativeP1Choices.mjs";

const writeArtifact = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2));
// Match P1's runtime projection only for source binding; transient lease IDs
// cannot make a recreated ready checkpoint appear to be different game history.
export function hashP2Snapshot(value) {
  const project = (node, at = "") => {
    if (Array.isArray(node)) return node.map((child, index) => project(child, `${at}/${index}`));
    if (!node || typeof node !== "object") return node;
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [key,
      at.endsWith("/attempt") && ["leaseId", "leaseExpiresAt"].includes(key) ? null : project(child, `${at}/${key}`)]));
  };
  return hashReplayValue(project(value));
}
const failureCode = error => typeof error?.message === "string" && /^(REPLAY_|P2_)/.test(error.message) ? error.message : "P2_PRODUCTION_DRIVER_FAILED";

/** Semantic cache state is part of the tape, including original sources and prepared hashes.
 * Stored lease predicates use the same separately compared transient lease projection as P1.
 * No field carrying narrative content, counters, watermarks or source hashes is omitted. */
export async function readP2MemoryState(client) {
  const tables = (await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map(row => row.name);
  const summaries = tables.includes("narrative_memory_summaries")
    ? (await client.execute("SELECT * FROM narrative_memory_summaries ORDER BY game_id, generation_id, observer_id, policy_version")).rows.map(row => {
      const { state_json, ...header } = row;
      return { ...header, state: JSON.parse(state_json) };
    }) : [];
  const attempts = tables.includes("narrative_memory_attempts")
    ? (await client.execute("SELECT * FROM narrative_memory_attempts ORDER BY game_id, generation_id, job_id, epoch")).rows.map(row => {
      const { expected_narrative_job_json, prepared_json, ...header } = row;
      return { ...header, guard: { attempt: JSON.parse(expected_narrative_job_json) }, prepared: prepared_json == null ? null : JSON.parse(prepared_json) };
    }) : [];
  return { summaries, attempts };
}

/** Production adapter. Tests may replace transport through runtimeFactory; game creation,
 * approval, actions, leases and both repositories always use the production composition. */
export async function createNarrativeP2ProductionRunner(runtimeEnv, options = {}) {
  const { createServerGameEntryPoints } = await import("../src/game/application/server/compositionRoot.ts");
  const { createSqliteGameRepository } = await import("../src/game/application/server/persistence/sqliteGameRepository.ts");
  const { createSqliteClient } = await import("../src/game/application/server/persistence/sqliteClient.ts");
  const { buildChoiceMap } = await import("../src/game/application/buildChoiceMap.ts");
  const { isStoryDeliveryComplete } = await import("../src/game/gameplay/rpg/storyDelivery/index.ts");
  const { PLAYER_ENTITY_ID } = await import("../src/game/domain/worldEntity.ts");
  const runtimeFactory = options.runtimeFactory ?? createNarrativeP1ReplayRuntime;
  return async input => {
    const { route, mode, protocol, outputDirectory, replaySource } = input;
    if (protocol.protocolVersion !== "narrative-p2/v2") throw new Error("P2_PROTOCOL_VERSION_UNSUPPORTED_USE_FROZEN_IMPLEMENTATION");
    // Internal offline control-policy fixtures remain executable during the v2 migration.
    // Public stage admission is separately closed by narrativeP2Journey.
    if (mode === "live" && !options.runtimeFactory) throw new Error("P2_STAGE_RUNTIME_NOT_IMPLEMENTED");
    if (mode === "live" && !options.runtimeFactory && process.env.RUN_REAL_AI_JOURNEY !== "1") throw new Error("P2_LIVE_REQUIRES_RUN_REAL_AI_JOURNEY");
    mkdirSync(outputDirectory, { recursive: true });
    const path = resolve(outputDirectory, `${route.routeId}.sqlite`);
    if (existsSync(path)) throw new Error("P2_ROUTE_ARTIFACT_ALREADY_EXISTS");
    const deadline = Date.now() + route.budget.wallClockMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), route.budget.wallClockMs);
    const stop = () => controller.abort();
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    const binding = { protocolHash: protocol.protocolHash, codeFingerprint: protocol.codeFingerprint, inputHash: protocol.inputHash };
    let runtime, entry, reader, client;
    let logicalAttempts = 0, actionCount = 0, reloads = 0;
    let querySubmitted = false, quoteInAuthor = false, checkpointCreated = false;
    let completed = false, coveragePassed = false, strictReplayPassed = false, failure;
    let oracle, recallResult;
    const auditFiles = [], requests = [], steps = [];
    const env = { ...runtimeEnv, NODE_ENV: "test", GAME_DB_PATH: path, AI_TEXT_AUDIT: "full",
      AI_TEXT_AUDIT_DIR: resolve(outputDirectory, "audit"), AI_OUTPUT_FORMAT: "prompt_only" };
    const reserve = () => {
      if (logicalAttempts >= route.budget.http || controller.signal.aborted || Date.now() >= deadline) return false;
      logicalAttempts += 1; return true;
    };
    const open = () => {
      const stream = `${route.routeId}-${auditFiles.length}`;
      auditFiles.push(`audit/${stream}/events.jsonl`);
      const aiRuntime = { ...runtime.options.aiRuntime, attempt: async (request, send) => {
        requests.push(request);
        return runtime.options.aiRuntime.attempt(request, send);
      } };
      // Composition owns its repository. A separate reader points at the same
      // SQLite path; externalRepository is intentionally never supplied.
      entry = createServerGameEntryPoints({ ...env, AI_TEXT_AUDIT_RUN_ID: stream }, undefined, undefined,
        { ...runtime.options, aiRuntime, memoryPolicy: protocol.policy, memorySummaries: "enabled",
          beforeNarrativeHttpAttempt: reserve, narrativeAbortSignal: controller.signal });
      reader = createSqliteGameRepository({ clientFactory: () => createSqliteClient(path) });
      client = createSqliteClient(path);
    };
    const close = async () => {
      if (entry) { await entry.close(); entry = undefined; }
      if (reader) { await reader.close(); reader = undefined; }
      if (client) { client.close(); client = undefined; }
    };
    const state = async key => {
      const game = await reader.getCurrentGame();
      const memory = await readP2MemoryState(client);
      runtime.state(key, { game, memory });
      return { game, memory };
    };
    try {
      runtime = runtimeFactory({ mode, directory: outputDirectory, sourceDirectory: replaySource, stream: route.routeId, binding,
        auditFiles: () => auditFiles.filter(file => existsSync(resolve(outputDirectory, file))) });
      open();
      const created = await entry.createGame({ gameType: protocol.input.gameType, gameLength: route.gameLength, setup: projectNarrativeP1GameSetup(protocol.input) }, `${route.routeId}-create`);
      if (!created.ok) throw new Error(`P2_CREATE_${created.code}`);
      await entry.ackPrologue(`${route.routeId}-ack`);
      const initial = await state("opening");
      if (!initial.game.ok || initial.game.status !== "active") throw new Error("P2_OPENING_MISSING");
      oracle = initial.game.record.storyState.history.entries.find(item => item.kind === "npc_line" && item.audienceIds.includes(PLAYER_ENTITY_ID));
      if (!oracle) throw new Error("P2_OPENING_QUOTE_MISSING");
      writeArtifact(resolve(outputDirectory, `${route.routeId}.oracle.json`), { history: oracle, openingAct: initial.game.record.storyState.currentAct });
      while (actionCount <= route.budget.actions) {
        if (controller.signal.aborted) throw new Error("P2_WALL_CLOCK_OR_INTERRUPTION");
        const current = await waitForNarrativeP1Generation(entry, `${route.routeId}-${actionCount}`, { signal: controller.signal, pollIntervalMs: options.pollIntervalMs ?? 250 });
        if (runtime.failureCode) throw new Error(runtime.failureCode);
        if (!current.ok || current.status !== "active" || current.view === undefined) throw new Error(`P2_CURRENT_${current.code ?? "UNAVAILABLE"}`);
        if (current.view.narrativeGeneration.status === "failed") throw new Error("P2_GENERATION_FAILED");
        const snapshot = await state(`ready:${actionCount}`);
        const game = snapshot.game;
        if (!game.ok || game.status !== "active" || game.record.revision !== current.revision) throw new Error("P2_STATE_MISMATCH");
        const record = game.record;
        const playerSummary = snapshot.memory.summaries.find(row => row.observer_id === String(PLAYER_ENTITY_ID));
        if (current.view.ending !== null) {
          completed = record.storyState.delivery !== undefined && hasCompletedCoreStory(game, isStoryDeliveryComplete)
            && record.worldState.eventLedger.filter(event => event.payload.type === "item_given" && event.payload.itemId === record.storyState.delivery.itemId && event.payload.npcId === record.storyState.delivery.recipientNpcId).length === 1;
          coveragePassed = completed && (route.gameLength === "short" || (querySubmitted && quoteInAuthor && playerSummary?.state.batches.length >= 2 && recallResult?.passed === true));
          if (!completed) failure = "P2_RULE_ENDING_FAILED";
          else if (!coveragePassed) failure = "P2_MEMORY_COVERAGE_FAILED";
          break;
        }
        if (actionCount === route.budget.actions) throw new Error("P2_ACTION_BUDGET_EXHAUSTED");
        const map = buildChoiceMap(record.worldState, record.storyState, record.revision);
        const focus = current.view.narrative.npcDialogues.find(npc => npc.freeInputEnabled);
        const canRecall = !querySubmitted && route.gameLength === "medium" && record.storyState.currentAct >= 3
          && !isStoryDeliveryComplete(record.worldState, record.storyState) && (playerSummary?.state.batches.length ?? 0) >= 2
          && (record.storyState.currentAct - initial.game.record.storyState.currentAct >= 2 || actionCount >= 8) && focus;
        let interaction;
        if (canRecall) {
          const baseline = snapshot;
          await close();
          const checkpointClient = createSqliteClient(path);
          try {
            const checkpoint = await checkpointClient.execute("PRAGMA wal_checkpoint(TRUNCATE)");
            if (Number(checkpoint.rows[0]?.busy ?? 0) !== 0) throw new Error("P2_CHECKPOINT_BUSY");
          } finally { checkpointClient.close(); }
          const checkpointPath = resolve(outputDirectory, `${route.routeId}.recall-ready.sqlite`);
          copyFileSync(path, checkpointPath, constants.COPYFILE_EXCL);
          checkpointCreated = true;
          // This is a legal ready checkpoint for the later human UI segment.
          // Opening it alone is not counted as UI acceptance.
          writeArtifact(resolve(outputDirectory, `${route.routeId}.ui-checkpoint.json`), {
            status: "not_executed", database: checkpointPath, protocolHash: protocol.protocolHash,
            sourceHash: hashP2Snapshot(baseline), revision: record.revision,
            input: protocol.recall, targetNpcId: focus.npcId,
            procedure: ["Use the registered runtime and the same remaining route budget.", "Submit the recorded free-text input through the UI, refresh, then continue legal choices to ending.", "Record UI actions and runtime tape; a screenshot alone does not pass UI acceptance."],
          });
          recallResult = await runAblation({ input, checkpointPath, baseline, targetNpcId: focus.npcId, oracle, runtimeEnv, runtimeFactory, adapters: { createServerGameEntryPoints, createSqliteGameRepository, createSqliteClient }, signal: controller.signal });
          open();
          await state(`reload:recall:${actionCount}`);
          reloads += 1;
          interaction = { kind: "free_text", targetNpcId: focus.npcId, text: protocol.recall };
          querySubmitted = true;
        } else {
          const selected = selectProductionChoice(current.view, "complete", map, currentStoryInteractions(record.worldState), new Set(), new Set(), record.storyState.delivery, actionCount);
          if (!selected) throw new Error("P2_NO_LEGAL_POLICY_ACTION");
          interaction = { kind: "fixed_choice", choiceToken: selected.choiceToken };
        }
        const requestStart = requests.length;
        const command = { actionId: `${route.routeId}-action-${actionCount}`, interaction, expectedRevision: current.revision };
        const after = await entry.performTurn(command, `${route.routeId}-turn-${actionCount}`);
        if (!after.ok) throw new Error(`P2_ACTION_${after.code}`);
        const settled = await reader.getCurrentGame();
        if (!settled.ok || settled.status !== "active" || settled.record.revision <= record.revision) throw new Error("P2_ACTION_NOT_SETTLED");
        steps.push({ actionCount, command, beforeState: `ready:${actionCount}`, action: interaction.kind === "fixed_choice" ? map.get(interaction.choiceToken) : null });
        actionCount += 1;
        if (interaction.kind === "free_text") {
          await waitForNarrativeP1Generation(entry, `${route.routeId}-recall`, { signal: controller.signal, pollIntervalMs: options.pollIntervalMs ?? 250 });
          quoteInAuthor = requests.slice(requestStart).some(request => request.context?.purpose === "narrative_bundle_generation" && containsQuote(request, oracle.text));
          runtime.state("recall-evidence", { oracleId: oracle.id, quoteInAuthor, actionCount, act: record.storyState.currentAct });
        }
        if (actionCount === 4) {
          await waitForNarrativeP1Generation(entry, `${route.routeId}-pre-reload`, { signal: controller.signal, pollIntervalMs: options.pollIntervalMs ?? 250 });
          const beforeReload = await state("before-reload");
          await close(); open();
          const afterReload = await state("after-reload");
          if (canonical(beforeReload) !== canonical(afterReload)) throw new Error("P2_RELOAD_MISMATCH");
          reloads += 1;
        }
      }
    } catch (error) { failure = runtime?.failureCode ?? failureCode(error); }
    finally {
      // Drain workers before sealing state/audit; failed routes remain in the denominator.
      try {
        if (entry) { await entry.close(); entry = undefined; }
        if (runtime && reader) await state("terminal");
        await close();
        if (runtime) { runtime.finish(); strictReplayPassed = mode === "replay"; }
      } catch (error) { failure = runtime?.failureCode ?? failureCode(error); completed = false; coveragePassed = false; }
      clearTimeout(timer); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
      writeArtifact(resolve(outputDirectory, `${route.routeId}.steps.json`), steps);
      writeArtifact(resolve(outputDirectory, `${route.routeId}.coverage.json`), { querySubmitted, quoteInAuthor, checkpointCreated, reloads, recallResult: recallResult ?? null });
    }
    return { completed, coveragePassed, strictReplayPassed, httpAttempts: mode === "replay" ? 0 : runtime?.attempts ?? 0,
      logicalAttempts, actionCount, ...(failure ? { failureCode: failure } : {}) };
  };
}

function containsQuote(request, quote) {
  return request.messages.some(message => message.content.includes(quote) || message.content.includes(JSON.stringify(quote).slice(1, -1)));
}

async function runAblation({ input, checkpointPath, baseline, targetNpcId, oracle, runtimeEnv, runtimeFactory, adapters, signal }) {
  const { mode, outputDirectory, replaySource, route, protocol } = input;
  const arms = [];
  for (const summaries of ["enabled", "disabled"]) {
    const stream = `${route.routeId}-ablation-${summaries}`;
    const path = resolve(outputDirectory, `${stream}.sqlite`);
    copyFileSync(checkpointPath, path, constants.COPYFILE_EXCL);
    const { createSqliteClient, createSqliteGameRepository, createServerGameEntryPoints } = adapters;
    const runtime = runtimeFactory({ mode, directory: outputDirectory, sourceDirectory: replaySource, stream,
      binding: { protocolHash: protocol.protocolHash, codeFingerprint: protocol.codeFingerprint, inputHash: protocol.inputHash, sourceHash: hashP2Snapshot(baseline), summaries }, auditFiles: [`audit/${stream}/events.jsonl`] });
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(stop, protocol.ablationBudget.wallClockMs);
    const deadline = Date.now() + protocol.ablationBudget.wallClockMs;
    let logicalAttempts = 0;
    const requests = [];
    const reader = createSqliteGameRepository({ clientFactory: () => createSqliteClient(path) });
    const client = createSqliteClient(path);
    const entry = createServerGameEntryPoints({ ...runtimeEnv, NODE_ENV: "test", GAME_DB_PATH: path, AI_TEXT_AUDIT: "full", AI_TEXT_AUDIT_DIR: resolve(outputDirectory, "audit"), AI_TEXT_AUDIT_RUN_ID: stream, AI_OUTPUT_FORMAT: "prompt_only" }, undefined, undefined,
      { ...runtime.options, memoryPolicy: protocol.policy, memorySummaries: summaries, narrativeAbortSignal: controller.signal,
        aiRuntime: { ...runtime.options.aiRuntime, attempt: async (request, send) => { requests.push(request); return runtime.options.aiRuntime.attempt(request, send); } },
        beforeNarrativeHttpAttempt: () => {
          if (logicalAttempts >= protocol.ablationBudget.http || controller.signal.aborted || Date.now() >= deadline) return false;
          logicalAttempts += 1; return true;
        } });
    let result = { summaries, ready: false, oracleId: oracle.id, quoteInAuthor: false };
    let closed = false;
    try {
      const before = { game: await reader.getCurrentGame(), memory: await readP2MemoryState(client) };
      if (canonical(before) !== canonical(baseline)) throw new Error("P2_ABLATION_BASELINE_MISMATCH");
      runtime.state("before", before);
      const command = { actionId: "p2-ablation-recall", expectedRevision: before.game.record.revision, interaction: { kind: "free_text", targetNpcId, text: protocol.recall } };
      const action = await entry.performTurn(command, `${stream}-action`);
      if (!action.ok) throw new Error(`P2_ABLATION_ACTION_${action.code}`);
      const generated = await waitForNarrativeP1Generation(entry, `${stream}-ensure`, { signal: controller.signal });
      result = { ...result, ready: generated.ok && generated.view?.narrativeGeneration.status === "idle",
        quoteInAuthor: requests.some(request => request.context?.purpose === "narrative_bundle_generation" && containsQuote(request, oracle.text)) };
    } catch (error) { result.failureCode = runtime.failureCode ?? failureCode(error); }
    finally {
      try {
        await entry.close(); closed = true;
        runtime.state("terminal", { game: await reader.getCurrentGame(), memory: await readP2MemoryState(client) });
        runtime.finish();
      } catch (error) { result.ready = false; result.failureCode = runtime.failureCode ?? failureCode(error); }
      clearTimeout(timer); signal?.removeEventListener("abort", stop);
      if (!closed) await entry.close();
      await reader.close(); client.close();
    }
    result = { ...result,
      requestLengths: requests.map(request => ({ purpose: request.context?.purpose, characters: request.messages.reduce((sum, message) => sum + message.content.length, 0) })),
      logicalAttempts, httpAttempts: mode === "replay" ? 0 : runtime.attempts };
    writeArtifact(resolve(outputDirectory, `${stream}.json`), result);
    arms.push(result);
  }
  return { sourceHash: hashP2Snapshot(baseline), arms, passed: arms.every(arm => arm.ready && arm.quoteInAuthor), narrativeQualityReviewed: false };
}

// Stage orchestration is a bounded internal seam until public admission is complete.
export { createNarrativeP2StageRunner } from "./narrativeP2Stage.mjs";
