// @vitest-environment node
import { describe, expect, it } from "vitest";
import { asTurnId } from "@/game/domain/events";
import { runTempleLetterJourney } from "./templeLetterJourney.testutil";
import { buildChoiceMap } from "../buildChoiceMap";
import { ruleEngine } from "@/game/gameplay/rpg/ruleEngine";
import { compileDecisionNarrativeContext } from "../server/ai/narrativeContext";

describe("delivered story exit contract", () => {
  it("projects the optional return graph only while the actual giver can receive the held item", async () => {
    const journey = await runTempleLetterJourney("exit_return");
    const pending = journey.snapshots.filter(record => record.storyState.narrative.status === "provider_pending");
    const prompts = pending.map(record => {
      if (record.storyState.narrative.status !== "provider_pending") throw new Error("pending snapshot missing");
      return { record, prompt: compileDecisionNarrativeContext({ worldState: record.worldState,
        storyState: record.storyState, job: record.storyState.narrative.job }).prompt };
    });
    const beforeReturn = prompts.find(({ record }) => !record.worldState.eventLedger.some(event => event.payload.type === "item_given"));
    expect(beforeReturn?.prompt).toContain("可选归还图");
    expect(beforeReturn?.prompt).toContain(`give_item:${beforeReturn?.record.storyState.delivery?.itemId}:npc_0`);
    expect(beforeReturn?.prompt).toContain("不得因存在此图就替玩家决定归还");
    for (const { record, prompt } of prompts) {
      if (record.worldState.eventLedger.some(event => event.payload.type === "item_given")) {
        expect(prompt).not.toContain("可选归还图");
      }
    }
  });
  it("removes abandonment and rejects it at the rule boundary after actual delivery", async () => {
    const journey = await runTempleLetterJourney("private");
    const delivered = journey.snapshots.find(record => record.worldState.ending === null
      && record.worldState.eventLedger.some(event => event.payload.type === "item_given"));
    expect(delivered).toBeDefined();
    if (delivered === undefined) throw new Error("delivery snapshot missing");
    const quest = delivered.worldState.quests.find(entry => entry.kind === "main" && entry.status === "active");
    expect(quest).toBeDefined();
    if (quest === undefined) throw new Error("active post-delivery quest missing");
    expect([...buildChoiceMap(delivered.worldState, delivered.storyState, delivered.revision).values()]
      .some(action => action.type === "abandon_quest")).toBe(false);
    expect(ruleEngine(delivered.worldState, delivered.storyState, { type: "abandon_quest", questId: quest.id },
      "illegal-post-delivery-exit", { now: () => "2026-09-13T00:00:00.000Z", turnId: asTurnId("illegal-post-delivery-exit") })).toMatchObject({ ok: false, code: "QUEST_NOT_ABANDONABLE" });
  });
});
