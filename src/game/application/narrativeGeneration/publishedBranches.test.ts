// @vitest-environment node
import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteClient } from "../server/persistence/sqliteClient";
import { createSqliteGameRepository } from "../server/persistence/sqliteGameRepository";
import { createSqliteNarrativeJobs } from "../server/persistence/sqliteNarrativeJobs";
import { asGameId } from "../server/persistence/gameRepository";
import { startDecisionJob, runDecision } from "./decisionJob";
import type { PlanProposal } from "@/game/domain/narrativePlan";
import { startInitialization, runInitialization } from "./initializationJob";
import { createFixtureOpeningCandidateSource } from "../createGame";
import { makeOpeningStagedPlan, makeOpeningChoiceOutput, makeNarrationOutput, makeCharacterOutput } from "@/game/domain/testing/stagedNarrativeFixture.testutil";
import { asGenerationId } from "@/game/domain/worldEntity";
import type { StageSource } from "./stageSource";
import { performTurn } from "../performTurn";
import { validatePersistableWorldState } from "../server/persistence/worldStatePersistenceValidation";
import { parsePersistableStoryState } from "../server/persistence/storyStatePersistenceValidation";
import { parseNarrativeRuntimeState } from "@/game/domain/narrative";
import { buildChoiceMap } from "../buildChoiceMap";

it.each(["legacy_route", "dialogue"] as const)("真实 SQLite 发布、选择与重载：%s", async mode => {
  const directory = mkdtempSync(join(tmpdir(), "rpg-published-branches-"));
  const candidate = await createFixtureOpeningCandidateSource().generate({ gameType: "wuxia", seed: "branch", gameLength: "short" });
  const basePlan = makeOpeningStagedPlan(candidate);
  if (basePlan.decision?.kind !== "ordinary") throw Error("ordinary opening expected");
  const plan: PlanProposal = mode === "legacy_route" ? basePlan : { ...basePlan, decision: { ...basePlan.decision!,
    options: [
      { ...basePlan.decision!.options[0], target: null, deferredLocation: null, dialogueAct: "ask" },
      { ...basePlan.decision!.options[1], target: null, deferredLocation: null, dialogueAct: "challenge", topic: { kind: "thread", threadId: "lead" } },
    ] } };
  const calls: string[] = [];
  const source: StageSource = { async generate(request) {
    calls.push(request.stage);
    if (request.stage === "planning") {
      if (request.context.kind === "opening") return { ok: true, stage: "planning", value: plan };
      const value: PlanProposal = { ...plan, opening: null,
        decision: mode === "legacy_route" || plan.decision?.kind !== "ordinary" ? plan.decision : { ...plan.decision, options: [
          plan.decision.options[0], { ...plan.decision.options[1], topic: { kind: "thread", threadId: "thread_init_lead" } },
        ] }, units: plan.units.map(unit => unit.stage !== "narration" ? unit : {
        ...unit, requiredBeats: request.context.kind !== "decision" ? [] : request.context.job.mandatoryBeats.map(beat => ({
          beatId: beat.beatId, kind: beat.kind, factIds: [], evidence: [], instruction: beat.instruction,
        })),
      }) };
      return { ok: true, stage: "planning", value };
    }
    if (request.stage === "narration") return { ok: true, stage: "narration", value: {
      ...makeNarrationOutput(), parts: request.context.unit.requiredBeats.length === 0 ? makeNarrationOutput().parts
        : request.context.unit.requiredBeats.map(beat => ({ text: "烛火在风中晃动。", facts: [], evidence: [], beatIds: [beat.beatId] })),
    } };
    if (request.stage === "character") return { ok: true, stage: "character", value: makeCharacterOutput("npc_0") };
    return { ok: true, stage: "choices", value: makeOpeningChoiceOutput() };
  } };
  const now = () => "2026-09-11T00:00:00.000Z";
  const outcomes: string[] = [];
  try {
    for (const index of [0, 1]) {
      const client = createSqliteClient(join(directory, `${index}.sqlite`));
      const errors: string[] = [];
      const logError = (_context: string, error: unknown) => errors.push(error instanceof Error ? error.message : String(error));
      const games = createSqliteGameRepository({ clientFactory: () => client, logError });
      const jobs = createSqliteNarrativeJobs({ client, logError });
      const originalPublish = jobs.publish;
      jobs.publish = async request => {
        if (request.publication.kind === "opening") {
          const { worldState, storyState } = request.publication.input;
          const world = validatePersistableWorldState(worldState);
          const story = parsePersistableStoryState(storyState, worldState.eventLedger);
          if (!world.ok) errors.push(JSON.stringify(world));
          if (!story.ok) errors.push(JSON.stringify(story));
          const narrative = parseNarrativeRuntimeState(storyState.narrative);
          if (!narrative.ok) errors.push(JSON.stringify(narrative));
        }
        return originalPublish(request);
      };
      try {
        await games.getCurrentGame();
        const started = await startInitialization({ requestId: `r${index}`, gameId: asGameId(`g${index}`), gameType: "wuxia", gameLength: "short", seed: "branch",
          generation: { generationId: asGenerationId("gen_branch"), seed: "branch", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
          target: { kind: "create" }, now }, jobs);
        if (!started.ok) throw new Error(started.code);
        const ran = await runInitialization(started.job.id, "worker", { jobs, source, now, signal: new AbortController().signal, createdAt: now() });
        if (!ran.ok) throw new Error(`${ran.code}: ${errors.join("\n")}`);
        const loaded = await games.getCurrentGame();
        if (!loaded.ok || loaded.status !== "active") throw new Error(JSON.stringify(loaded));
        let record = loaded.record;
        // 玩家先关闭序幕，再选择已由生产生成链发布的 token。
        const ack = await games.applyState({ gameId: record.gameId, expectedRevision: record.revision,
          nextWorldState: record.worldState, nextStoryState: { ...record.storyState, prologueShown: true }, incrementRevision: false });
        expect(ack).toMatchObject({ ok: true });
        const reloaded = await games.getCurrentGame();
        if (!reloaded.ok || reloaded.status !== "active") throw new Error("reload failed");
        record = reloaded.record;
        const narrative = record.storyState.narrative;
        if (narrative.status !== "ready") throw new Error("not ready");
        const choice = narrative.choiceRegistry[index]!;
        if (mode === "legacy_route") expect(choice.branch).toBeDefined();
        else expect(choice.branch).toBeUndefined();
        const before = record.worldState.currentLocationId;
        const selected = await performTurn({ gameId: record.gameId, actionId: "pick", interaction: { kind: "fixed_choice", choiceToken: choice.choiceToken },
          expectedRevision: record.revision, choiceMap: buildChoiceMap(record.worldState, record.storyState, record.revision) }, { repository: games, now });
        expect(selected, errors.join("\n")).toMatchObject({ ok: true });
        const final = await games.getCurrentGame();
        if (!final.ok || final.status !== "active") throw new Error("final reload failed");
        expect(final.record.worldState.currentLocationId).toBe(before);
        if (mode === "dialogue") {
          expect(final.record.worldState.locations).toEqual(record.worldState.locations);
          expect(final.record.worldState.quests[0]?.objectives).toEqual(record.worldState.quests[0]?.objectives);
          const pending = final.record.storyState.narrative;
          if (pending.status !== "provider_pending") throw Error("pending dialogue expected");
          expect(pending.job.selectedDialogue?.dialogueAct).toBe(choice.action.type === "talk" ? choice.action.dialogueAct : null);
          const started = await startDecisionJob({ record: final.record, now }, jobs);
          if (!started.ok) throw Error(started.code);
          const beforeCalls = calls.length;
          const ran = await runDecision(started.job.id, "dialogue_worker", { jobs, source, now, signal: new AbortController().signal, createdAt: now() });
          expect(ran).toMatchObject({ ok: true });
          expect(calls.slice(beforeCalls)).toEqual(["planning", "narration", "character", "choices"]);
          const published = await games.getCurrentGame();
          if (!published.ok || published.status !== "active" || published.record.storyState.narrative.status !== "ready") throw Error("published expected");
          expect(published.record.storyState.narrative.choiceRegistry).toHaveLength(2);
          expect(published.record.storyState.narrative.choiceRegistry.every(choice => choice.branch === undefined)).toBe(true);
          expect(published.record.worldState.locations).toEqual(record.worldState.locations);
          outcomes.push(pending.job.selectedDialogue!.dialogueAct);
          continue;
        }
        expect(final.record.storyState.selectedBranches[choice.branch!.decisionId]).toBe(choice.branch!.candidateId);
        const routes = final.record.worldState.locations.filter(location => ["北滩", "南岗"].includes(location.name));
        expect(routes).toHaveLength(1);
        outcomes.push(routes[0]!.name);
        expect(final.record.worldState.quests[0]?.objectives[0]).toEqual({ kind: "visit_location", locationId: routes[0]!.id });
        expect(final.record.worldState.eventLedger.filter(event => event.kind === "narrative_branch_selected")).toHaveLength(1);
      } finally { await jobs.close(); await games.close(); await client.close(); }
    }
    if (mode === "legacy_route") expect(outcomes).toEqual(["北滩", "南岗"]);
    else expect(new Set(outcomes).size).toBe(2);
  } finally {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* Windows SQLite may retain handles; preserve this isolated test directory. */ }
  }
});
