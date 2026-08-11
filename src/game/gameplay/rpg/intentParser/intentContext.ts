import type { WorldState } from "@/game/domain/worldState";
import { findLocation } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { FactId, QuestId } from "@/game/domain/worldEntity";
import type { ThreadId } from "@/game/domain/storyState";

export type IntentContextEntity = {
  readonly id: string;
  readonly name: string;
};

/** 服务端供应的合法主题引用（Task 5 Step 3）：live 解析器只允许从中选择。 */
export type IntentTopicRef =
  | { readonly kind: "fact"; readonly id: FactId }
  | { readonly kind: "quest"; readonly id: QuestId }
  | { readonly kind: "thread"; readonly id: ThreadId };

export type IntentContext = {
  readonly currentLocationName: string;
  readonly connectedLocations: readonly IntentContextEntity[];
  readonly presentNpcs: readonly IntentContextEntity[];
  readonly availableItems: readonly IntentContextEntity[];
  readonly undiscoveredFacts: readonly IntentContextEntity[];
  readonly activeQuests: readonly IntentContextEntity[];
  /** Task 5：结构化主题引用白名单（已发现事实 / 活跃任务 / 未解决线程）。 */
  readonly topicRefs: readonly IntentTopicRef[];
};

export function buildIntentContext(ws: WorldState, ss?: StoryState): IntentContext {
  const currentLoc = findLocation(ws, ws.currentLocationId);

  const connectedLocations = currentLoc
    ? currentLoc.connectedLocationIds
        .map((id) => findLocation(ws, id))
        .filter((l): l is NonNullable<typeof l> => l !== undefined)
        .map((l) => ({ id: String(l.id), name: l.name }))
    : [];

  const presentNpcs = ws.npcs
    .filter((n) => n.locationId === ws.currentLocationId)
    .map((n) => ({ id: String(n.id), name: n.name }));

  const availableItems = currentLoc
    ? currentLoc.availableItemIds
        .map((id) => ws.items.find((i) => i.id === id))
        .filter((i): i is NonNullable<typeof i> => i !== undefined)
        .map((i) => ({ id: String(i.id), name: i.name }))
    : [];

  const undiscoveredFacts = ws.worldFacts
    .filter((f) => !f.discovered)
    .map((f) => ({ id: String(f.factId), name: f.text.slice(0, 20) }));

  const activeQuests = ws.quests
    .filter((q) => q.status === "active")
    .map((q) => ({ id: String(q.id), name: q.name }));

  // 主题引用白名单：只含服务端可确认的实体 ID；未发现事实/未解锁实体一律不在内。
  const topicRefs: IntentTopicRef[] = [
    ...ws.worldFacts
      .filter((f) => f.discovered)
      .map((f) => ({ kind: "fact" as const, id: f.factId })),
    ...activeQuests.map((q) => ({ kind: "quest" as const, id: q.id as QuestId })),
    ...(ss?.unresolvedThreads.map((t) => ({ kind: "thread" as const, id: t })) ?? []),
  ];

  return {
    currentLocationName: currentLoc?.name ?? "未知",
    connectedLocations,
    presentNpcs,
    availableItems,
    undiscoveredFacts,
    activeQuests,
    topicRefs,
  };
}
