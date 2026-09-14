import { entitiesOfKind } from "@/game/domain/entity";
import { asTurnId } from "@/game/domain/events";
import type { StoryState } from "@/game/domain/storyState";
import type { WorldState } from "@/game/domain/worldState";
import { endingStanceNpc } from "@/game/gameplay/rpg/narrativeBundle";
import { resolveTurn } from "@/game/gameplay/rpg/ruleEngine";

/** Conditional, read-only rule previews. No preview event IDs or private text escape. */
export function projectEndingResolutions(worldState: WorldState, storyState: StoryState) {
  const npc = endingStanceNpc(worldState);
  if (npc === undefined) return [];
  const actions = (["support", "challenge"] as const).map(dialogueAct => ({ type: "talk" as const, npcId: npc.id, dialogueAct }));
  const actionPreviews = actions.map(action => {
    // These IDs and timestamp live only in an immutable rule calculation, never in a ledger write.
    const previewId = `conditional-ending-preview:${action.dialogueAct}`;
    const preview = resolveTurn(worldState, storyState, action, previewId, 0, asTurnId(previewId), "fixed_choice", {
      now: () => "2000-01-01T00:00:00.000Z", turnId: asTurnId(previewId),
    });
    if (!preview.ok) return { action, status: "rejected" as const, code: preview.code };
    const { resolution } = preview;
    const next = resolution.nextWorldState;
    const previousItems = entitiesOfKind(worldState.entityStore, "item");
    const itemOwnershipChanges = entitiesOfKind(next.entityStore, "item").flatMap(item => {
      const before = previousItems.find(previous => previous.core.id === item.core.id)?.possession.owner;
      const after = item.possession.owner;
      return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ itemId: item.core.id, before, after }];
    });
    return {
      action, status: resolution.primaryResult.status,
      resultingLocationId: next.currentLocationId,
      // Exhaustive effects from this actual Action; missing actions cannot be supplied by prose.
      events: resolution.domainEvents.map(event => ({ kind: event.kind, targetIds: event.targetIds, locationId: event.locationId })),
      itemOwnershipChanges,
      newlyDiscoveredFactIds: next.worldFacts.filter(fact => fact.discovered
        && !worldState.worldFacts.some(before => before.factId === fact.factId && before.discovered)).map(fact => fact.factId),
      resolvedEndingId: next.ending?.endingId ?? null,
    };
  });
  return (["trust", "doubt"] as const).map((themeKey, index) => ({
    themeKey, basisKey: `ending:${themeKey}`,
    choiceAction: actions[index]!,
    generationLocationId: worldState.currentLocationId,
    displayCondition: { kind: "matching_rule_ending" as const, themeKey },
    actionPreviews,
    authority: "choiceLabel 只表达 choiceAction；scene 只在实际 endingId 匹配本主题时发布，两结果不同时发生。actionPreviews 是同一生成状态下分别执行真实立场 Action 的条件预览，不是已提交事件，不可用作事件引用或提前授知。结局对尚未生成时 resolvedEndingId=null，不代表结局不可能；结局名称和正文不提供额外行动权限。实际规则可将 support 导向 doubt，结果正文不得据主题反推玩家一定执行了哪种立场。中心冲突必须在既有事实与这些真实后果内得到具体结果；无预览效果与既有已发生依据的关键行动不得写成完成，也不得把尚待履行的条件或承诺改写为兑现。",
  }));
}
