import { describe, expect, it } from "vitest";
import { buildChoiceMap } from "../buildChoiceMap";
import { commitState } from "../stateCommit";
import { createFixtureOpeningCandidateSource, createGame } from "../createGame";
import { performTurn } from "../performTurn";
import type { NarrativeBundleSource } from "../narrativeBundleSource";
import type { GameRecord, GameRepository } from "../server/persistence/gameRepository";
import { asGameId } from "../server/persistence/gameRepository";
import { buildOpeningHandoffContext, compileDecisionNarrativeContext } from "../server/ai/narrativeContext";
import type { OpeningGenerationCandidate } from "@/game/domain/openingGenerationCandidate";

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

function openingSource(): NarrativeBundleSource {
  const candidateSource = createFixtureOpeningCandidateSource();
  return {
    async generate(context) {
      if (context.kind !== "opening") return { ok: false, failure: { kind: "AI_CALL_FAILED", phase: "scene" } };
      const base = await candidateSource.generate(context.input);
      const opening: OpeningGenerationCandidate = {
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
      };
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
  it("carries each real approved choice and the selected thread's public causal chain", async () => {
    const created = repository();
    const result = await createGame(
      { gameId: asGameId("opening-handoff"), gameType: "science_fiction", gameLength: "short", seed: "handoff" },
      { repository: created.repo, source: openingSource(), now: () => "2026-09-09T00:00:00.000Z" },
    );
    expect(result.ok).toBe(true);
    const approved = created.record();
    expect(approved.storyState.unresolvedThreads).not.toContain("thread_init_shutdown");

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
  });
});
