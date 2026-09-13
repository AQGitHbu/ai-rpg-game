// @vitest-environment node
import { expect, it } from "vitest";
import { runTempleLetterJourney } from "./templeLetterJourney.testutil";
import { projectGameSessionView } from "../gameSessionView";
import { buildChoiceMap } from "../buildChoiceMap";
// @ts-expect-error Executable acceptance runner shares the production read model.
import { offeredProductionChoices, selectProductionChoice, currentStoryInteractions, findOfferedStoryDelivery } from "../../../../scripts/narrativeP1Choices.mjs";

it("selects the formal map move at an act boundary even without scene or location buttons", async () => {
  const { snapshots } = await runTempleLetterJourney("private");
  const boundary = snapshots.find(record => {
    const view = projectGameSessionView(record.worldState, record.storyState, record.revision, "hud-move");
    const actions = buildChoiceMap(record.worldState, record.storyState, record.revision);
    return view.story.currentObjectiveChoiceToken !== null
      && actions.get(view.story.currentObjectiveChoiceToken)?.type === "move";
  });
  expect(boundary).toBeDefined();
  if (boundary === undefined) throw new Error("formal move boundary missing");
  const view = projectGameSessionView(boundary.worldState, boundary.storyState, boundary.revision, "hud-move");
  const actions = buildChoiceMap(boundary.worldState, boundary.storyState, boundary.revision);
  const selected = selectProductionChoice({ ...view, narrative: { ...view.narrative, choices: [], npcDialogues: [] },
    currentLocation: { ...view.currentLocation, actions: [] } }, "complete", actions,
    currentStoryInteractions(boundary.worldState), new Set());
  expect(selected?.choiceToken).toBe(view.story.currentObjectiveChoiceToken);
  expect(view.worldMap.locations.map(location => location.travelChoice)).toContainEqual(selected);
  expect(actions.get(selected?.choiceToken)).toMatchObject({ type: "move" });
});

it("selects the actual NPC panel promise instead of a generic location greeting", async () => {
  const { snapshots } = await runTempleLetterJourney("exit_keep");
  const opening = snapshots[0]!;
  const view = projectGameSessionView(opening.worldState, opening.storyState, opening.revision, "choice-projection");
  const actions = buildChoiceMap(opening.worldState, opening.storyState, opening.revision);
  expect(view.narrative.choices).toEqual([]);
  expect(view.narrative.npcDialogues.flatMap(dialogue => dialogue.choices).length).toBeGreaterThan(0);
  const selected = selectProductionChoice(view, "private", actions, currentStoryInteractions(opening.worldState), new Set());
  const action = actions.get(selected?.choiceToken);
  expect(action?.type).toBe("talk");
  if (action?.type !== "talk") throw new Error("actual NPC choice missing");
  expect(action.interactionId).toBeDefined();
  expect(currentStoryInteractions(opening.worldState).find((entry: { id: string }) => entry.id === action.interactionId)?.operation).toBe("promise_confidentiality");
  expect(offeredProductionChoices(view)).toContainEqual(selected);
});

it("selects the real prepared delivery after verification and never treats return to giver as delivery", async () => {
  const { snapshots } = await runTempleLetterJourney("verify_first");
  const ready = snapshots.find(record => record.storyState.narrative.status === "ready"
    && record.storyState.delivery?.recipientNpcId != null
    && record.worldState.npcs.some(npc => npc.id === record.storyState.delivery?.recipientNpcId && npc.locationId === record.worldState.currentLocationId)
    && record.worldState.eventLedger.some(event => event.payload.type === "story_interaction_resolved" && event.payload.operation === "request_verification")
    && !record.worldState.eventLedger.some(event => event.payload.type === "item_given"));
  if (ready === undefined) throw new Error("pre-delivery verification snapshot missing");
  const view = projectGameSessionView(ready.worldState, ready.storyState, ready.revision, "verified-delivery");
  const actions = buildChoiceMap(ready.worldState, ready.storyState, ready.revision);
  const selected = selectProductionChoice(view, "diagnostic", actions, currentStoryInteractions(ready.worldState),
    new Set(["promise_confidentiality", "request_introduction", "verify_freeform_submitted", "request_verification"]), new Set(), ready.storyState.delivery);
  expect(actions.get(selected?.choiceToken)).toMatchObject({ type: "give_item", itemId: ready.storyState.delivery?.itemId, npcId: ready.storyState.delivery?.recipientNpcId });
  expect(selected?.choiceToken).not.toBe(view.story.currentObjectiveChoiceToken);
  const returnJourney = await runTempleLetterJourney("exit_return");
  for (const record of returnJourney.snapshots) {
    const returnView = projectGameSessionView(record.worldState, record.storyState, record.revision, "return-check");
    expect(findOfferedStoryDelivery(returnView, buildChoiceMap(record.worldState, record.storyState, record.revision), record.storyState.delivery)).toBeUndefined();
  }
});

it("uses a real authored opening response when the requested operation is not yet offered", async () => {
  const { snapshots } = await runTempleLetterJourney("private");
  const opening = snapshots[0]!;
  const view = projectGameSessionView(opening.worldState, opening.storyState, opening.revision, "opening-response");
  const actions = buildChoiceMap(opening.worldState, opening.storyState, opening.revision);
  const selected = selectProductionChoice(view, "private", actions, currentStoryInteractions(opening.worldState), new Set());
  const authored = view.narrative.npcDialogues.flatMap(dialogue => dialogue.choices);
  expect(authored).toContainEqual(selected);
  expect(selected?.choiceToken).not.toBe(view.story.currentObjectiveChoiceToken);
});
