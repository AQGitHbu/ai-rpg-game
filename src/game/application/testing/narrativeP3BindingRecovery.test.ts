/** @vitest-environment node */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createSqliteClient } from "../server/persistence/sqliteClient";
import { createSqliteGameRepository } from "../server/persistence/sqliteGameRepository";
import { asGameId } from "../server/persistence/gameRepository";
import { createTempleLetterBundleSource } from "./templeLetterJourney.testutil";
import { createGame } from "../createGame";
import { performTurn } from "../performTurn";
import { buildChoiceMap } from "../buildChoiceMap";
import { projectGameSessionView } from "../gameSessionView";
import { generatePendingNarrativeBundle } from "../generatePendingNarrativeBundle";
import { approveStoryConsequenceBindings } from "../approveStoryConsequenceBindings";
import type { NarrativeBundleSource } from "../narrativeBundleSource";
import type { StoryConsequenceBindingsProposal } from "@/game/domain/storyConsequenceBindings";
import { asFactId, asNpcId, asQuestId } from "@/game/domain/worldEntity";
import { applyEntityMutations } from "@/game/gameplay/rpg/entityWorld";

describe("P3 binding publication boundary", () => {
  it("rejects retroactive completion in B without advancing A's quest or publishing a stale scene", async () => {
    const directory = mkdtempSync(join(tmpdir(), "p3-binding-"));
    const repository = createSqliteGameRepository({ clientFactory: () => createSqliteClient(join(directory, "game.sqlite")) });
    const now = () => "2026-09-15T00:00:00.000Z";
    const base = createTempleLetterBundleSource("private");
    const conditions = [{ kind: "knows_fact" as const, actorId: asNpcId("npc_0"), factId: asFactId("fact_0") }];
    const bindings: StoryConsequenceBindingsProposal = [{
      kind: "bind_talk_completion", questRef: "quest_0", npcRef: "npc_0", conditions,
    }];
    let decisionAttempts = 0;
    const source: NarrativeBundleSource = {
      async generate(context) {
        const result = await base.generate(context);
        if (context.kind !== "decision" || !result.ok || result.kind !== "decision") return result;
        decisionAttempts += 1;
        return { ...result, proposal: { ...result.proposal, consequenceBindings: bindings } };
      },
    };
    const read = async () => {
      const result = await repository.getCurrentGame();
      if (!result.ok || result.status !== "active") throw new Error("missing test game");
      return result.record;
    };
    try {
      await repository.initializeSchema();
      expect((await createGame({ gameId: asGameId("p3_binding"), gameType: "wuxia", gameLength: "short", seed: "binding" },
        { repository, source, now, aiEnabled: false })).ok).toBe(true);
      const initial = await read();
      // Before any dialogue, the same condition is a valid future completion rule.
      expect(approveStoryConsequenceBindings({ proposal: bindings, worldState: initial.worldState,
        storyState: initial.storyState, symbols: new Map() }).ok).toBe(true);
      const view = projectGameSessionView(initial.worldState, initial.storyState, initial.revision, "test");
      const choice = [...view.narrative.choices, ...view.narrative.npcDialogues.flatMap((npc) => npc.choices)]
        .find((entry) => entry.label.includes("先问清楚"));
      expect(choice).toBeDefined();
      expect((await performTurn({ gameId: initial.gameId, actionId: "binding-first-ask", expectedRevision: initial.revision,
        interaction: { kind: "fixed_choice", choiceToken: choice!.choiceToken },
        choiceMap: buildChoiceMap(initial.worldState, initial.storyState, initial.revision) }, { repository, now })).ok).toBe(true);
      const afterA = await read();
      expect(afterA.storyState.currentAct).toBe(1);
      expect(approveStoryConsequenceBindings({ proposal: bindings, worldState: afterA.worldState,
        storyState: afterA.storyState, symbols: new Map() })).toMatchObject({ ok: false, code: "retroactive_talk_completion" });

      // An already installed identical binding is still idempotent when fulfilled.
      const installed = applyEntityMutations(afterA.worldState, [{ kind: "bind_quest_talk_completion",
        questId: asQuestId("quest_0"), npcId: asNpcId("npc_0"), conditions }]);
      expect(installed.ok).toBe(true);
      if (!installed.ok) throw new Error("invalid fixture binding");
      expect(approveStoryConsequenceBindings({ proposal: bindings, worldState: installed.worldState,
        storyState: afterA.storyState, symbols: new Map() }).ok).toBe(true);

      await generatePendingNarrativeBundle({ repository, source, now });
      const afterB = await read();
      expect(decisionAttempts).toBeGreaterThan(0);
      expect(afterB.storyState.narrative.status).not.toBe("ready");
      expect(afterB.storyState.currentAct).toBe(afterA.storyState.currentAct);
      expect(afterB.storyState.evolution).toEqual(afterA.storyState.evolution);
      expect(afterB.worldState.quests).toEqual(afterA.worldState.quests);
      expect(afterB.worldState.eventLedger).toEqual(afterA.worldState.eventLedger);
      expect(afterB.storyState.history).toEqual(afterA.storyState.history);
    } finally {
      await repository.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
