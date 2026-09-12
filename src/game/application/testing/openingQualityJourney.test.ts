import { describe, expect, it, vi } from "vitest";
import { buildChoiceMap } from "../buildChoiceMap";
import { commitState } from "../stateCommit";
import { createFixtureOpeningCandidateSource, createGame } from "../createGame";
import { performTurn } from "../performTurn";
import type { NarrativeBundleSource } from "../narrativeBundleSource";
import type { GameRecord, GameRepository } from "../server/persistence/gameRepository";
import { asGameId } from "../server/persistence/gameRepository";
import { buildOpeningHandoffContext, compileDecisionNarrativeContext } from "../server/ai/narrativeContext";
import type { OpeningGenerationCandidate } from "@/game/domain/openingGenerationCandidate";
import { generatePendingNarrativeBundle } from "../generatePendingNarrativeBundle";
import { createNarrativeBundleSource } from "../server/ai/liveNarrativeBundleSource";
import type { RpgAiClient } from "../server/ai/rpgAiClient";
import type { AiMessage } from "@ai-game/ai-transport";

function repository(initial: GameRecord | null = null): { repo: GameRepository; record: () => GameRecord } {
  let current = initial === null ? null : structuredClone(initial);
  const repo: GameRepository = {
    async createInitialGame(input) {
      if (current !== null) return { ok: false, code: "ACTIVE_GAME_EXISTS" as const };
      current = { gameId: input.gameId, worldState: input.worldState, storyState: input.storyState, revision: 0, createdAt: input.createdAt };
      return { ok: true };
    },
    async getCurrentGame() {
      return current === null
        ? { ok: true as const, status: "none" as const }
        : { ok: true as const, status: "active" as const, record: current };
    },
    async applyState(input) {
      if (current === null || input.expectedRevision !== current.revision) return { ok: false, code: "STALE_GAME_REVISION" as const };
      current = { ...current, worldState: input.nextWorldState, storyState: input.nextStoryState, revision: current.revision + (input.incrementRevision === false ? 0 : 1) };
      return { ok: true, record: current };
    },
    async applySceneWriteBack(input) {
      if (current === null || input.expectedRevision !== current.revision) return { ok: false, code: "STALE_GAME_REVISION" as const };
      current = { ...current, worldState: input.nextWorldState, storyState: input.nextStoryState, revision: current.revision + 1 };
      return { ok: true, record: current };
    },
    async clearCurrentGame() { current = null; return { ok: true }; },
    async replaceCurrentGame() { return { ok: false, code: "STALE_GAME_REVISION" as const }; },
  };
  return { repo, record: () => { if (current === null) throw new Error("missing record"); return current; } };
}

function openingSource(transform: (candidate: OpeningGenerationCandidate) => OpeningGenerationCandidate = (candidate) => candidate): NarrativeBundleSource {
  const candidateSource = createFixtureOpeningCandidateSource();
  return {
    async generate(context) {
      if (context.kind !== "opening") return { ok: false, failure: { kind: "AI_CALL_FAILED", phase: "scene" } };
      const base = await candidateSource.generate(context.input);
      const opening = transform({
        ...base,
        world: {
          ...base.world,
          publicFacts: [
            { key: "shared_repair", text: "主角过去曾与船厂技师共同维修引擎" },
            { key: "shutdown_problem", text: "老旧引擎必须立刻停机检查" },
            { key: "hidden_mistake", text: "技师私自隐去了上次维修失误" },
            { key: "maintenance_log", text: "停机记录存放在主控台的只读终端" },
          ],
        },
        opening: {
          ...base.opening,
          npc: {
            ...base.opening.npc,
            knownFactKeys: ["shared_repair", "shutdown_problem", "maintenance_log"],
            privateFactKeys: ["hidden_mistake"],
          },
          situation: {
            history: [
              { key: "shared", factKeys: ["shared_repair"], participantRefs: ["player", "opening_npc"], causeHistoryKeys: [] },
              { key: "mistake", factKeys: ["hidden_mistake"], participantRefs: ["opening_npc"], causeHistoryKeys: ["shared"] },
              { key: "log", factKeys: ["maintenance_log"], participantRefs: ["player", "opening_npc"], causeHistoryKeys: [] },
            ],
            threads: [{
              key: "shutdown", questionFactKey: "shutdown_problem",
              supportingFactKeys: ["shared_repair", "hidden_mistake"],
              participantRefs: ["player", "opening_npc"], causeHistoryKeys: ["shared", "mistake"],
            }],
            npcConnection: { familiarity: "known", stance: "neutral", basisHistoryKeys: ["shared"] },
            responses: [
              { key: "ask_repair", dialogueAct: "ask", topic: { kind: "fact", key: "maintenance_log" } },
              { key: "refuse_shutdown", dialogueAct: "refuse", topic: { kind: "thread", key: "shutdown" } },
            ],
          },
          firstScene: {
            ...base.opening.firstScene!,
            npcLine: { ...base.opening.firstScene!.npcLine, usedFactKeys: ["shutdown_problem"] },
            choices: [
              { candidateId: "ask_repair", label: "先说清楚我们上次维修时发生了什么" },
              { candidateId: "refuse_shutdown", label: "我现在不能答应停机" },
            ],
          },
        },
      });
      return {
        ok: true, kind: "opening",
        proposal: {
          opening,
          currentScene: {
            segments: [{ beatId: "opening", text: opening.opening.firstScene!.narration }],
            npcLine: { npcId: "npc_0", text: opening.opening.firstScene!.npcLine.text, emotion: "guarded", answeredBeatIds: [], usedFactIds: ["fact_1"], usedEventIds: [] },
            objectiveLink: null,
            choices: opening.opening.firstScene!.choices,
          },
          continuationScenes: [], terminal: { kind: "next_decision", target: { kind: "current_scene" } },
        },
      };
    },
  };
}

describe("opening quality create → ack → choice → decision context", () => {
  it("accepts question/support overlap through createGame without classifying it as a source failure", async () => {
    const created = repository();
    const result = await createGame(
      { gameId: asGameId("opening-overlap-create"), gameType: "science_fiction", gameLength: "short", seed: "overlap" },
      {
        repository: created.repo,
        source: openingSource((candidate) => ({
          ...candidate,
          opening: {
            ...candidate.opening,
            situation: {
              ...candidate.opening.situation,
              threads: candidate.opening.situation.threads.map((thread, index) => index === 0
                ? { ...thread, supportingFactKeys: [thread.questionFactKey, ...thread.supportingFactKeys] }
                : thread),
            },
          },
        })),
        now: () => "2026-09-09T00:00:00.000Z",
      },
    );

    expect(result.ok).toBe(true);
    const thread = created.record().worldState.eventLedger.find((event) => event.kind === "opening_thread_established")!;
    expect(thread.factIds).toEqual(["fact_1", "fact_0", "fact_2"]);
  });

  it("rejects a real oversized first-turn opening context before calling the production provider", async () => {
    const created = repository();
    const repeated = "公开背景。".repeat(100);
    const result = await createGame(
      { gameId: asGameId("opening-overflow"), gameType: "science_fiction", gameLength: "short", seed: "overflow" },
      {
        repository: created.repo,
        source: openingSource((candidate) => ({
          ...candidate,
          world: {
            ...candidate.world,
            publicFacts: candidate.world.publicFacts.map((fact, index) => ({ ...fact, text: `${index}:${repeated}` })),
          },
          opening: {
            ...candidate.opening,
            npc: { ...candidate.opening.npc, privateFactKeys: [], knownFactKeys: candidate.world.publicFacts.map((fact) => fact.key) },
            situation: {
              ...candidate.opening.situation,
              history: candidate.world.publicFacts.map((_, index) => ({
                key: `history_${index}`,
                factKeys: candidate.world.publicFacts.map((fact) => fact.key),
                participantRefs: ["player", "opening_npc"] as const,
                causeHistoryKeys: index === 0 ? [] : [`history_${index - 1}`],
              })),
              threads: candidate.opening.situation.threads.map((thread) => ({
                ...thread,
                supportingFactKeys: candidate.world.publicFacts.map((fact) => fact.key),
                causeHistoryKeys: ["history_3"],
              })),
              npcConnection: { familiarity: "known", stance: "neutral", basisHistoryKeys: ["history_0"] },
            },
          },
        })),
        now: () => "2026-09-09T00:00:00.000Z",
      },
    );
    expect(result.ok).toBe(true);
    const before = created.record();
    const token = before.storyState.narrative.status === "ready" ? before.storyState.narrative.currentScene.choices[1]!.choiceToken : "";
    const turn = await performTurn({
      gameId: before.gameId,
      actionId: "overflow-choice",
      expectedRevision: before.revision,
      interaction: { kind: "fixed_choice", choiceToken: token },
      choiceMap: buildChoiceMap(before.worldState, before.storyState, before.revision),
    }, { repository: created.repo, now: () => "2026-09-09T00:01:00.000Z" });
    expect(turn.ok).toBe(true);
    const pending = created.record();
    if (pending.storyState.narrative.status !== "provider_pending") throw new Error("missing first-turn job");
    const compilation = compileDecisionNarrativeContext({ worldState: pending.worldState, storyState: pending.storyState, job: pending.storyState.narrative.job });
    expect(compilation.manifest.overflowEstimatedTokens).toBeGreaterThan(0);

    const complete = vi.fn();
    const aiClient: RpgAiClient = {
      complete,
      policy: () => ({ thinking: "off", timeoutMs: 1_000, maxTokens: 5_000, jsonMode: "prompt_only", maxAttempts: 1 }),
    };
    const sourceResult = await createNarrativeBundleSource({ aiClient }).generate({
      kind: "decision",
      worldState: pending.worldState,
      storyState: pending.storyState,
      job: pending.storyState.narrative.job,
    });

    expect(sourceResult).toMatchObject({ ok: false, repairReason: "context_budget_exceeded" });
    expect(complete).not.toHaveBeenCalled();
  });
  it("carries each real approved choice and the selected thread's public causal chain", async () => {
    const created = repository();
    const result = await createGame(
      { gameId: asGameId("opening-handoff"), gameType: "science_fiction", gameLength: "short", seed: "handoff" },
      { repository: created.repo, source: openingSource(), now: () => "2026-09-09T00:00:00.000Z" },
    );
    expect(result.ok).toBe(true);
    const approved = created.record();
    expect(approved.storyState.unresolvedThreads).toContain("thread_init_shutdown");

    const branches = [repository(approved), repository(approved)];
    for (const branch of branches) {
      const ack = await commitState(branch.repo, {
        gameId: branch.record().gameId, expectedRevision: 0,
        nextWorldState: branch.record().worldState,
        nextStoryState: { ...branch.record().storyState, prologueShown: true },
        incrementRevision: false,
      });
      expect(ack.ok).toBe(true);
    }
    const tokens = approved.storyState.narrative.status === "ready"
      ? approved.storyState.narrative.currentScene.choices.map((choice) => choice.choiceToken)
      : [];
    expect(tokens).toHaveLength(2);

    for (let index = 0; index < branches.length; index += 1) {
      const branch = branches[index]!;
      const before = branch.record();
      const turn = await performTurn({
        gameId: before.gameId, actionId: `choice-${index}`, expectedRevision: before.revision,
        interaction: { kind: "fixed_choice", choiceToken: tokens[index]! },
        choiceMap: buildChoiceMap(before.worldState, before.storyState, before.revision),
      }, { repository: branch.repo, now: () => "2026-09-09T00:01:00.000Z" });
      expect(turn.ok).toBe(true);
    }

    const first = branches[0]!.record();
    const second = branches[1]!.record();
    if (first.storyState.narrative.status !== "provider_pending" || second.storyState.narrative.status !== "provider_pending") throw new Error("missing jobs");
    const firstJob = first.storyState.narrative.job;
    const secondJob = second.storyState.narrative.job;
    expect(firstJob.selectedDialogue).toMatchObject({ dialogueAct: "ask", topic: { kind: "fact", factId: "fact_3" } });
    expect(secondJob.selectedDialogue).toMatchObject({ dialogueAct: "refuse", topic: { kind: "thread", threadId: "thread_init_shutdown" }, label: "我现在不能答应停机" });
    expect(second.worldState.eventLedger.filter((event) => event.kind === "item_given" || event.kind === "location_visited")).toEqual([]);

    const firstHandoff = buildOpeningHandoffContext({ worldState: first.worldState, job: firstJob });
    expect(firstHandoff?.requiredEventIds).toEqual(expect.arrayContaining([expect.stringContaining("history_log")]));
    expect(firstHandoff?.requiredEventIds).not.toEqual(expect.arrayContaining([expect.stringContaining("history_mistake")]));

    const compilation = compileDecisionNarrativeContext({ worldState: second.worldState, storyState: second.storyState, job: secondJob });
    const handoff = compilation.context.selected.find((entry) => entry.id === "bundle:opening-handoff");
    expect(handoff).toBeDefined();
    expect(handoff?.retention).toBe("mandatory");
    expect(handoff?.source.refs).toEqual(expect.arrayContaining([
      expect.stringContaining("history_shared"),
      expect.stringContaining("thread_shutdown"),
    ]));
    expect(compilation.prompt).toContain("主角过去曾与船厂技师共同维修引擎");
    expect(compilation.prompt).toContain("我现在不能答应停机");
    expect(compilation.prompt).not.toContain("技师私自隐去了上次维修失误");
    expect(compilation.manifest.selectedEstimatedTokens).toBeLessThanOrEqual(8_000);
    expect(compilation.prompt.match(/eventId=.*thread_shutdown/g)).toHaveLength(1);

    const freeInputHandoff = buildOpeningHandoffContext({
      worldState: second.worldState,
      job: { ...secondJob, selectedDialogue: { dialogueAct: "ask" }, utterance: "先别催，我要看完整的停机记录" },
    });
    expect(freeInputHandoff?.requiredEventIds).toEqual(expect.arrayContaining([
      expect.stringContaining("history_shared"), expect.stringContaining("thread_shutdown"),
    ]));
    expect(freeInputHandoff?.publicText).toContain("先别催，我要看完整的停机记录");

    const later = compileDecisionNarrativeContext({ worldState: second.worldState, storyState: second.storyState, job: { ...secondJob, turnNumber: 2 } });
    expect(later.context.selected.some((entry) => entry.id === "bundle:opening-handoff")).toBe(false);
    expect(buildOpeningHandoffContext({
      worldState: { ...second.worldState, eventLedger: second.worldState.eventLedger.filter((event) => event.kind !== "game_initialized") },
      job: secondJob,
    })).toBeNull();

    const capturedMessages: AiMessage[][] = [];
    const aiClient: RpgAiClient = {
      async complete(_role, messages) {
        capturedMessages.push([...messages]);
        return { ok: false, code: "invalid_response", retryable: false, latencyMs: 1 };
      },
      policy: () => ({ thinking: "off", timeoutMs: 1_000, maxTokens: 5_000, jsonMode: "prompt_only", maxAttempts: 1 }),
    };
    const sourceResult = await generatePendingNarrativeBundle({
      repository: branches[1]!.repo,
      source: createNarrativeBundleSource({ aiClient }),
      now: () => "2026-09-09T00:02:00.000Z",
    });
    expect(sourceResult.ok).toBe(false);
    expect(capturedMessages).toHaveLength(3);
    const actualDecisionPrompt = capturedMessages[0]!.map((message) => message.content).join("\n");
    expect(actualDecisionPrompt).toContain("[relevant_events] 开局背景与本次回应");
    expect(actualDecisionPrompt).toContain("主角过去曾与船厂技师共同维修引擎");
    expect(actualDecisionPrompt).toContain("我现在不能答应停机");
    expect(actualDecisionPrompt).toContain("先直接回答或明确承认自己不知道");
    expect(actualDecisionPrompt).toContain("不能补写状态中没有的既成事实");
    expect(actualDecisionPrompt).toContain("选项 label 必须忠于其服务端 Action");
    expect(actualDecisionPrompt).toContain('current_scene_choice_1 => {"type":"talk"');
    expect(actualDecisionPrompt).toContain('"dialogueAct":"support"');
    expect(actualDecisionPrompt).toContain('"topic":"general"');
    expect(actualDecisionPrompt).toContain("本次所选结构化意图：dialogueAct=refuse；topic=thread:thread_init_shutdown");
    expect(actualDecisionPrompt).not.toContain("技师私自隐去了上次维修失误");
    expect(capturedMessages.map((messages) => messages.map((message) => message.content).join("\n").match(/eventId=.*thread_shutdown/g)?.length)).toEqual([1, 1, 1]);
    expect(branches[1]!.record().worldState.eventLedger.filter((event) => event.kind === "opening_history_established")).toHaveLength(3);
  });
});
