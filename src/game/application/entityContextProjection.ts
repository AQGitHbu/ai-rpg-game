import { projectEntityStore, type EntityKind } from "@/game/domain/entity";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { StoryState } from "@/game/domain/storyState";
import type { WorldState } from "@/game/domain/worldState";

export type NarrativeEntitySummary = Readonly<{ id: string; kind: EntityKind; name: string; summary: string; locationId?: string }>;
export type EntityContextProjection = Readonly<{ mandatory: readonly NarrativeEntitySummary[]; optional: readonly NarrativeEntitySummary[]; occupiedNames: Readonly<Record<"location" | "npc" | "item" | "enemy" | "quest", readonly string[]>> }>;

/** 从权威 store 投影上下文，调用者不应把 legacy arrays 当作 Prompt 事实来源。 */
export function buildEntityContextProjection(input: { readonly worldState: WorldState; readonly storyState: StoryState; readonly job: PendingNarrativeJob; readonly optionalLimit?: number }): EntityContextProjection {
  const p = projectEntityStore(input.worldState.entityStore);
  const action = input.job.actionSummary;
  const ids = new Set<string>(["player_0", String(p.currentLocationId), ...(input.job.focusNpcId === undefined ? [] : [String(input.job.focusNpcId)])]);
  if (action.kind === "talk") ids.add(String(action.npcId));
  if (action.kind === "move") ids.add(String(action.locationId));
  if (action.kind === "take_item") ids.add(String(action.itemId));
  if (action.kind === "give_item") { ids.add(String(action.itemId)); ids.add(String(action.npcId)); }
  if (action.kind === "investigate") ids.add(String(action.factId));
  if (action.kind === "attack") ids.add(String(action.enemyId));
  const activeQuest = p.quests.find((quest) => quest.status === "active" && quest.kind === "main") ?? p.quests.find((quest) => quest.status === "active");
  if (activeQuest !== undefined) {
    ids.add(String(activeQuest.id));
    const objective = input.job.objectiveTransition.after;
    if (objective !== null && String(objective.questId) === String(activeQuest.id)) {
      const target = activeQuest.objectives[objective.objectiveIndex];
      if (target !== undefined) ids.add(String(Object.values(target).find((value) => typeof value === "string") ?? ""));
    }
  }
  const summaries: NarrativeEntitySummary[] = [
    { id: "player_0", kind: "player_character", name: p.player.name, summary: `身份=${p.player.identity}`, locationId: String(p.currentLocationId) },
    ...p.locations.map((x) => ({ id: String(x.id), kind: "location" as const, name: x.name, summary: x.description, locationId: String(x.id) })),
    ...p.npcs.map((x) => ({ id: String(x.id), kind: "npc" as const, name: x.name, summary: `角色=${x.role}；${x.description}`, locationId: String(x.locationId) })),
    ...p.items.map((x) => ({ id: String(x.id), kind: "item" as const, name: x.name, summary: x.description })),
    ...p.enemies.map((x) => ({ id: String(x.id), kind: "enemy" as const, name: x.name, summary: `强度=${x.tier}`, locationId: String(x.locationId) })),
    ...p.quests.map((x) => ({ id: String(x.id), kind: "quest" as const, name: x.name, summary: x.description })),
    ...p.worldFacts.filter((x) => x.discovered && !p.npcs.some((npc) => npc.memory.hiddenFactIds.includes(x.factId))).map((x) => ({ id: String(x.factId), kind: "fact" as const, name: "已发现线索", summary: x.text, locationId: x.locationId === undefined ? undefined : String(x.locationId) })),
  ];
  const mandatory = summaries.filter((x) => ids.has(x.id)).sort((a, b) => a.id.localeCompare(b.id));
  const optional = summaries.filter((x) => !ids.has(x.id) && x.locationId === String(p.currentLocationId)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, input.optionalLimit ?? 12);
  return { mandatory, optional, occupiedNames: { location: p.locations.map((x) => x.name).sort(), npc: p.npcs.map((x) => x.name).sort(), item: p.items.map((x) => x.name).sort(), enemy: p.enemies.map((x) => x.name).sort(), quest: p.quests.map((x) => x.name).sort() } };
}
