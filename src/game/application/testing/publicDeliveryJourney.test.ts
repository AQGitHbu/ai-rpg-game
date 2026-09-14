/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGame } from "../createGame";
import { performTurn } from "../performTurn";
import { generatePendingNarrativeBundle } from "../generatePendingNarrativeBundle";
import { buildChoiceMap } from "../buildChoiceMap";
import { projectGameSessionView } from "../gameSessionView";
import type { NarrativeBundleSource } from "../narrativeBundleSource";
import { asGameId } from "../server/persistence/gameRepository";
import { createSqliteClient } from "../server/persistence/sqliteClient";
import { createSqliteGameRepository } from "../server/persistence/sqliteGameRepository";
import { compileNarrativeDraft, projectNarrativeDraft } from "../server/ai/narrativeDraftProjection";
import { buildDecisionNarrativeContextBlocks } from "../server/ai/narrativeContext/narrativeBundleContext";
import { parseNarrativeBundleProposal } from "@/game/domain/narrativeBundle";
import { isStoryDeliveryComplete } from "@/game/gameplay/rpg/storyDelivery";
import { createTempleLetterBundleSource } from "./templeLetterJourney.testutil";

// Test author prose only. Routing, compilation, approval, materialization and
// read-model actions below are the production pipeline, not a hand-built bundle.
const source: NarrativeBundleSource = {
  async generate(context) {
    if (context.kind === "opening") {
      const result = await createTempleLetterBundleSource().generate(context);
      if (!result.ok || result.kind !== "opening") throw new Error("opening fixture unavailable");
      const opening = result.proposal.opening;
      return { ...result, proposal: { ...result.proposal, opening: { ...opening,
        world: { ...opening.world, publicFacts: [{ key: "letter_route", text: "乡亲约定由邻村渡口的值守人收取这封公开家书。" }, { key: "letter_seal", text: "家书是普通报平安的来信。" }] },
        storyContract: { ...opening.storyContract, centralConflict: "把乡亲的家书亲手送给约定的收信人。" },
        opening: { ...opening.opening, npc: { ...opening.opening.npc, privateFactKeys: [], knownFactKeys: ["letter_route", "letter_seal"] } },
      } } };
    }
    const { storyState, job } = context;
    const authorBlocks = buildDecisionNarrativeContextBlocks(context);
    const reviewerBlocks = buildDecisionNarrativeContextBlocks({ ...context, consumer: "reviewer" });
    const endpoint = authorBlocks.find(block => block.id === "bundle:delivery-endpoint");
    expect(endpoint).toBeDefined();
    expect(reviewerBlocks.find(block => block.id === "bundle:delivery-endpoint")).toEqual(endpoint);
    expect(endpoint!.content).toContain(`"completed":${isStoryDeliveryComplete(context.worldState, storyState)}`);
    expect(endpoint!.content).toContain('"factId":"fact_0"');
    expect(authorBlocks.find(block => block.id === "bundle:world-evolution")!.content).not.toContain("必须提供 newLocation、newNpc、newItem、newEnemy");
    const projection = projectNarrativeDraft(context);
    const next = projection.nextActProjection;
    const worldDelta = next !== null ? {
      beatSummary: "前往下一处交接地点。",
      newLocation: { name: `交接地点${storyState.currentAct}`, description: "村道旁的歇脚处。", scale: "scene", placement: "world", connectFromLocationId: String(context.worldState.currentLocationId) },
      newNpc: { name: `值守人${storyState.currentAct}`, role: "乡亲约定的值守人", description: "熟悉本地公开约定的村民。", locationRef: { kind: "new_location" }, existingFactIds: ["fact_0"],
        anchors: { selfConcept: "替乡亲照看信件", values: ["守约"], speechStyle: "直白", capabilityBoundaries: ["只谈村道与交接约定"], taboos: [] },
        goals: [{ horizon: "short", description: "说明家书的去向", priority: 3, reason: "乡亲约定需要兑现" }], relationshipSeeds: [] },
      newItem: null, newEnemy: null, newFact: null,
      nextMainQuest: { name: `家书路线${storyState.currentAct}`, description: "把家书送到约定地点。", objectiveText: "前往地点与值守人交谈" }, endingPair: null,
    } : projection.terminal.kind === "ending" && context.worldState.endings.length < 2 ? {
      beatSummary: "家书已送达，谈谈这次委托。", newLocation: null, newNpc: null, newItem: null, newEnemy: null, newFact: null, nextMainQuest: null,
      endingPair: [{ themeKey: "trust", name: "守约", description: "家书送到，认可这份托付。" }, { themeKey: "doubt", name: "留疑", description: "家书送到，仍对托付有所保留。" }],
    } : null;
    const sceneDrafts = projection.slots.map(slot => {
      const descriptor = projection.descriptorGraph.steps.find(step => step.stepKey === slot.slotKey);
      const npcId = slot.slotKey === "current" ? job.focusNpcId : next?.npcId ?? descriptor?.arrivalNpc?.id;
      const candidates = slot.choiceCount === 0 ? [] : next !== null
        ? [`${slot.slotKey}_choice_1`, `${slot.slotKey}_choice_2`]
        : (slot.slotKey === "current" ? projection.descriptorGraph.currentChoiceCandidates : descriptor!.choiceCandidates).map(candidate => candidate.candidateId);
      return { slotKey: slot.slotKey, scene: {
        segments: slot.slotKey === "current" ? job.mandatoryBeats.filter(beat => beat.beatId !== "atmosphere").map(beat => ({ beatId: beat.beatId, text: "你说明了自己的想法。" })) : [],
        npcLine: npcId === undefined ? null : { npcId: String(npcId), text: "乡亲约定由渡口值守人收信。这份约定我知道，我们接着谈。", emotion: "neutral", answeredBeatIds: slot.slotKey === "current" ? job.mandatoryBeats.filter(beat => beat.kind === "player_utterance").map(beat => beat.beatId) : [], usedFactIds: ["fact_0"], usedEventIds: [] },
        objectiveLink: slot.slotKey === "current" && next === null && job.objectiveTransition.after !== null ? { questId: String(job.objectiveTransition.after.questId), objectiveIndex: job.objectiveTransition.after.objectiveIndex, mode: "progress" } : null,
        choices: candidates.map((candidateId, index) => ({ candidateId, label: index === 0 ? "认可你的说法" : "对此仍有疑问" })),
      } };
    });
    const endingOutcomes = projection.terminal.kind === "ending" ? ["trust", "doubt"].map(themeKey => ({ themeKey, choiceLabel: themeKey === "trust" ? "认可这次托付" : "保留对托付的疑问", scene: { segments: [{ beatId: "atmosphere", text: "家书已经送达，这次托付结束了。" }], npcLine: null, objectiveLink: null, choices: [] } })) : undefined;
    const compiled = compileNarrativeDraft({ worldDelta, sceneDrafts, ...(endingOutcomes === undefined ? {} : { endingOutcomes }) }, context);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled));
    const parsed = parseNarrativeBundleProposal(compiled.value);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed));
    return { ok: true, kind: "decision", proposal: parsed.proposal };
  },
};

function visibleTokens(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => key === "choiceToken" && typeof child === "string" ? [child] : visibleTokens(child));
}

describe("public delivery through the production draft pipeline", () => {
  it("keeps delivery reachable across act preview and arrival, then persists one real transfer and ending", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rpg-public-delivery-"));
    const dbPath = join(directory, "journey.sqlite");
    const open = () => createSqliteGameRepository({ clientFactory: () => createSqliteClient(dbPath), logError: (_context, error) => { throw error; } });
    let repository = open();
    const now = () => "2026-09-14T00:00:00.000Z";
    const read = async () => {
      const saved = await repository.getCurrentGame();
      if (!saved.ok || saved.status !== "active") throw new Error("missing saved game");
      return saved.record;
    };
    try {
      await repository.initializeSchema();
      expect(await createGame({ gameId: asGameId("public_delivery"), gameType: "wuxia", gameLength: "short", seed: "public_delivery" }, { repository, source, now, aiEnabled: false })).toMatchObject({ ok: true });
      let reloaded = false;
      let delivered = false;
      for (let turn = 0; turn < 24; turn += 1) {
        let record = await read();
        if (record.storyState.narrative.status === "provider_pending") {
          const generated = await generatePendingNarrativeBundle({ repository, source, now });
          record = await read();
          expect({ generated, failure: record.storyState.narrative.status === "provider_failed" ? record.storyState.narrative.failure : null }).toMatchObject({ generated: { ok: true }, failure: null });
        }
        if (!delivered) expect(record.worldState.ending).toBeNull();
        if (record.worldState.ending !== null) break;
        if (!reloaded && record.storyState.currentAct === 3) {
          await repository.close();
          repository = open();
          await repository.initializeSchema();
          expect(await read()).toEqual(record);
          reloaded = true;
        }
        const map = buildChoiceMap(record.worldState, record.storyState, record.revision);
        const view = projectGameSessionView(record.worldState, record.storyState, record.revision, "public-delivery");
        const actions = visibleTokens(view).flatMap(token => map.has(token) ? [{ token, action: map.get(token)! }] : []);
        const bundle = record.storyState.narrative.status === "ready" ? record.storyState.narrative.narrativeBundle : undefined;
        const activeMoveIds = bundle?.steps.filter(step => bundle.activeStepIds.includes(step.stepId) && step.trigger.kind === "move").map(step => step.trigger.kind === "move" ? step.trigger.locationId : null) ?? [];
        const chosen = actions.find(entry => entry.action.type === "give_item" && entry.action.npcId === record.storyState.delivery?.recipientNpcId)
          ?? actions.find(entry => entry.action.type === "move" && activeMoveIds.includes(entry.action.locationId))
          ?? actions.find(entry => entry.action.type === "talk" && entry.action.dialogueAct === (turn % 2 === 0 ? "support" : "challenge"))
          ?? actions.find(entry => entry.action.type === "talk");
        expect(chosen, JSON.stringify(view.narrative)).toBeDefined();
        if (chosen!.action.type === "give_item") {
          expect(isStoryDeliveryComplete(record.worldState, record.storyState)).toBe(false);
          expect(record.worldState.inventory).toContain(record.storyState.delivery!.itemId);
          expect(record.worldState.quests.find(quest => quest.kind === "main" && quest.stage === 3)?.status).toBe("active");
          expect(bundle?.steps.find(step => bundle.activeStepIds.includes(step.stepId))?.trigger.kind).toBe("give_item");
          // Arrival cannot expose the final talk choices and consume the quest
          // before the explicit transfer has happened.
          expect(view.narrative.choices).toEqual([]);
          expect(record.storyState.endingAllowed).toBe(false);
        }
        const result = await performTurn({ gameId: record.gameId, actionId: `public_${turn}`, interaction: { kind: "fixed_choice", choiceToken: chosen!.token }, expectedRevision: record.revision, choiceMap: map }, { repository, now });
        expect(result, JSON.stringify({ result, action: chosen!.action, turn, act: record.storyState.currentAct })).toMatchObject({ ok: true });
        delivered ||= chosen!.action.type === "give_item";
      }
      const final = await read();
      expect(reloaded).toBe(true);
      expect(isStoryDeliveryComplete(final.worldState, final.storyState)).toBe(true);
      expect(final.worldState.ending).not.toBeNull();
      expect(final.storyState.narrative.status).toBe("ready");
      expect(final.worldState.items).toHaveLength(1);
      expect(final.worldState.eventLedger.filter(event => event.kind === "item_given")).toHaveLength(1);
      await repository.close();
      repository = open();
      await repository.initializeSchema();
      expect(await read()).toEqual(final);
    } finally {
      await repository.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
