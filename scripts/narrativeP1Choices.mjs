export function currentStoryInteractions(worldState) {
  return worldState.entityStore.records.flatMap((entity) => entity.core.kind === "npc" ? entity.interactions ?? [] : []);
}

export function offeredProductionChoices(view) {
  const npcChoices = (view.narrative.npcDialogues ?? []).flatMap(dialogue => [
    ...(dialogue.choices ?? []), ...(dialogue.giveChoices ?? []).map(entry => entry.choice),
  ]);
  const battleChoices = (view.battle?.controls ?? []).filter(choice => choice.enabled !== false && choice.choiceToken);
  const worldChoices = [
    ...(view.worldMap?.locations ?? []).flatMap(location => location.travelChoice ? [location.travelChoice] : []),
    ...(view.obtainableItems ?? []).map(item => item.choice),
    ...(view.currentLocation.npcs ?? []).flatMap(npc => npc.talkChoice ? [npc.talkChoice] : []),
    ...(view.currentLocation.investigations ?? []).flatMap(investigation => (investigation.choices ?? []).map(choice => ({
      ...choice,
      presentation: "investigate",
    }))),
    ...(view.currentLocation.town?.interactiveBuildings ?? []).flatMap(building => building.arrivalChoiceToken ? [{
      choiceToken: building.arrivalChoiceToken, label: building.displayName,
    }] : []),
  ];
  return [...new Map([...worldChoices, ...view.narrative.choices, ...npcChoices, ...view.currentLocation.actions, ...battleChoices].map((choice) => [choice.choiceToken, choice])).values()];
}

export function findOfferedStoryDelivery(view, actionMap, delivery) {
  if (delivery?.recipientNpcId == null) return undefined;
  return offeredProductionChoices(view).find(choice => {
    const action = actionMap.get(choice.choiceToken);
    return action?.type === "give_item" && action.itemId === delivery.itemId && action.npcId === delivery.recipientNpcId;
  });
}

export function selectProductionChoice(view, routeKind, actionMap, interactions, performed, performedActions = new Set(), delivery, actionCount = 0) {
  const choices = offeredProductionChoices(view);
  const operation = (choice) => {
    const action = actionMap.get(choice.choiceToken);
    return action?.type === "talk" ? interactions.find((entry) => entry.id === action.interactionId)?.operation : undefined;
  };
  if (routeKind === "complete") {
    if (view.battle) return choices.find(choice => actionMap.get(choice.choiceToken)?.type === "battle_action" && actionMap.get(choice.choiceToken).action === "skill")
      ?? choices.find(choice => actionMap.get(choice.choiceToken)?.type === "battle_action" && actionMap.get(choice.choiceToken).action === "attack");
    const deliveryChoice = findOfferedStoryDelivery(view, actionMap, delivery);
    if (deliveryChoice) return deliveryChoice;
    const allowed = choice => {
      const action = actionMap.get(choice.choiceToken);
      // A new formal decision may offer the same Action with a fresh token,
      // including a later dialogue round or the ending decision.
      return action && !["give_item", "abandon_quest"].includes(action.type);
    };
    const objective = choices.find(choice => choice.choiceToken === view.story.currentObjectiveChoiceToken && allowed(choice));
    if (objective && actionMap.get(objective.choiceToken).type !== "talk") return objective;
    const dialogueChoices = [...view.narrative.choices, ...(view.narrative.npcDialogues ?? []).flatMap(dialogue => dialogue.choices ?? [])];
    return dialogueChoices.find(choice => allowed(choice) && operation(choice) === undefined)
      ?? dialogueChoices.find(allowed) ?? objective
      ?? choices.find(choice => allowed(choice) && actionMap.get(choice.choiceToken).type === "explore");
  }
  if (routeKind === "deliver" || routeKind === "withdraw") {
    if (routeKind === "withdraw" && actionCount >= 4) return choices.find(choice => actionMap.get(choice.choiceToken)?.type === "abandon_quest");
    const deliveryChoice = findOfferedStoryDelivery(view, actionMap, delivery);
    if (routeKind === "deliver" && deliveryChoice) return deliveryChoice;
    const allowed = choice => {
      const action = actionMap.get(choice.choiceToken);
      return action && !["give_item", "abandon_quest"].includes(action.type) && !performedActions.has(JSON.stringify(action));
    };
    const objective = choices.find(choice => choice.choiceToken === view.story.currentObjectiveChoiceToken && allowed(choice));
    if (objective && actionMap.get(objective.choiceToken)?.type !== "talk") return objective;
    return [...view.narrative.choices, ...(view.narrative.npcDialogues ?? []).flatMap(dialogue => dialogue.choices ?? [])].find(allowed) ?? objective;
  }
  const wanted = (routeKind === "private" || routeKind === "diagnostic")
    ? (!performed.has("promise_confidentiality") ? "promise_confidentiality" : !performed.has("request_introduction") ? "request_introduction" : routeKind === "diagnostic" && !performed.has("verify_freeform_submitted") ? "await_delivery_opportunity" : routeKind === "diagnostic" && !performed.has("request_verification") ? "request_verification" : null)
    : routeKind === "verify_first" && !performed.has("verify_freeform_submitted")
      ? "await_delivery_opportunity"
      : (!performed.has("request_verification") ? "request_verification" : null);
  const specific = choices.find((choice) => wanted !== null && operation(choice) === wanted && !performedActions.has(JSON.stringify(actionMap.get(choice.choiceToken))));
  if (specific !== undefined) return specific;
  const deliveryChoice = findOfferedStoryDelivery(view, actionMap, delivery);
  if (wanted === null && deliveryChoice !== undefined && !performedActions.has(JSON.stringify(actionMap.get(deliveryChoice.choiceToken)))) return deliveryChoice;
  const allowed = (choice) => {
    const action = actionMap.get(choice.choiceToken);
    if (action === undefined || action.type === "abandon_quest") return false;
    if (performedActions.has(JSON.stringify(action))) return false;
    if (action.type === "give_item" && (wanted !== null || choice.choiceToken !== deliveryChoice?.choiceToken)) return false;
    const op = operation(choice);
    return op === undefined || (wanted === null && !performed.has(op) && ((routeKind === "private" || routeKind === "diagnostic") || !["promise_confidentiality", "request_introduction"].includes(op)));
  };
  const objective = choices.find(choice => choice.choiceToken === view.story.currentObjectiveChoiceToken && allowed(choice));
  // Physical objective steps bridge the current approved graph. At dialogue
  // boundaries use actual authored buttons before the generic location greeting.
  if (objective !== undefined && actionMap.get(objective.choiceToken)?.type !== "talk") return objective;
  const dialogueChoices = [...view.narrative.choices,
    ...(view.narrative.npcDialogues ?? []).flatMap(dialogue => dialogue.choices ?? [])];
  return dialogueChoices.find(allowed) ?? objective;
}

