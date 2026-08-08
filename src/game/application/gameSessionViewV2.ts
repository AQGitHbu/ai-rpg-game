import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { LocationId, NpcId, EnemyId } from "@/game/domain/scenarioBlueprint";
import { paginateSpeechText, composeDeterministicNpcLine, NPC_SCENE_PAGE_CHAR_BUDGET } from "@/game/domain";

export type GameSessionViewV2 = {
  readonly revision: number;
  readonly gameType: string;
  readonly player: { readonly name: string; readonly identity: string; readonly hp: number; readonly attack: number; readonly defense: number };
  readonly currentLocation: { readonly id: LocationId; readonly name: string; readonly description: string };
  readonly availableNpcs: readonly { readonly id: NpcId; readonly name: string; readonly role: string; readonly met: boolean }[];
  readonly availableMoves: readonly { readonly locationId: LocationId; readonly name: string }[];
  readonly inventory: readonly { readonly itemId: string; readonly name: string }[];
  readonly story: {
    readonly currentAct: number;
    readonly targetActs: number;
    readonly tension: number;
    readonly pacingNeed: string;
    readonly storyProgress: number;
  };
  readonly narrative: {
    readonly mode: string;
    readonly hasScene: boolean;
    readonly eventKind?: string;
    readonly narration?: string;
    readonly choices?: readonly { readonly choiceToken: string; readonly label: string; readonly actionKey: string }[];
    readonly npcLine?: { readonly npcId: string; readonly text: string; readonly emotion: string } | null;
    /** 在场 NPC 的对白（场景对白优先，缺失/空页回退确定性台词）；与 availableNpcs 一一对应。 */
    readonly npcDialogues?: readonly { readonly npcId: string; readonly npcName: string; readonly npcRole: string; readonly speechPages: readonly string[] }[];
  };
  readonly narrativeGeneration?: { readonly status: string; readonly totalApiCalls: number };
  readonly battle: { readonly enemyName: string; readonly playerHp: number; readonly enemyHp: number; readonly round: number } | null;
  readonly quests: readonly {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly kind: string;
    readonly status: string;
    readonly objectives: readonly { readonly label: string; readonly completed: boolean }[];
  }[];
  readonly prologueShown: boolean;
  readonly ending: { readonly endingId: string; readonly outcome: string } | null;
};

export function projectGameSessionView(
  worldState: WorldState,
  storyState: StoryState,
  revision: number,
): GameSessionViewV2 {
  const currentLoc = worldState.locations.find((l) => l.id === worldState.currentLocationId);
  const npcsHere = worldState.npcs.filter((n) => n.locationId === worldState.currentLocationId);
  const moves = currentLoc?.connectedLocationIds
    .filter((id) => worldState.unlockedLocationIds.includes(id))
    .map((id) => {
      const loc = worldState.locations.find((l) => l.id === id);
      return { locationId: id, name: loc?.name ?? "???" };
    }) ?? [];

  const scene = storyState.narrative.currentScene;
  const hasScene = scene !== null;

  // 每 NPC 对白：场景 npcDialogues 有非空分页时直用；否则回退焦点 npcLine 或确定性台词。
  const sceneDialoguesById = new Map(
    (scene?.npcDialogues ?? []).map((d) => [String(d.npcId), d])
  );
  const npcDialogues = npcsHere.map((n) => {
    const sceneEntry = sceneDialoguesById.get(String(n.id));
    if (sceneEntry !== undefined && sceneEntry.speechPages.length > 0) {
      return {
        npcId: String(n.id),
        npcName: n.name,
        npcRole: n.role,
        speechPages: sceneEntry.speechPages,
      };
    }
    const isFocus = scene?.npcLine !== null && scene?.npcLine !== undefined
      && String(scene.npcLine.npcId) === String(n.id)
      && scene.npcLine.text.trim() !== "";
    const text = isFocus
      ? scene!.npcLine!.text.trim()
      : composeDeterministicNpcLine(n.name, n.role);
    return {
      npcId: String(n.id),
      npcName: n.name,
      npcRole: n.role,
      speechPages: paginateSpeechText(text, NPC_SCENE_PAGE_CHAR_BUDGET),
    };
  });

  // Battle projection
  const battle: GameSessionViewV2["battle"] = (() => {
    if (worldState.battle.status !== "active") return null;
    const battle = worldState.battle;
    if (battle.status !== "active") return null;
    const enemy = worldState.enemies.find((e) => e.id === battle.enemyId);
    return {
      enemyName: enemy?.name ?? "???",
      playerHp: worldState.battle.playerHp,
      enemyHp: worldState.battle.enemyHp,
      round: worldState.battle.round,
    };
  })();

  // Quests projection（含派生 label 和 completed）
  const quests: GameSessionViewV2["quests"] = worldState.quests.map((q) => ({
    id: String(q.id),
    name: q.name,
    description: q.description,
    kind: q.kind,
    status: q.status,
    objectives: q.objectives.map((o) => {
      let label = "";
      let completed = false;
      switch (o.kind) {
        case "visit_location": {
          const loc = worldState.locations.find((l) => l.id === o.locationId);
          label = `前往${loc?.name ?? "未知地点"}`;
          completed = worldState.visitedLocationIds.includes(o.locationId);
          break;
        }
        case "talk_to_npc": {
          const npc = worldState.npcs.find((n) => n.id === o.npcId);
          label = `与${npc?.name ?? "某人"}交谈`;
          completed = npc?.met ?? false;
          break;
        }
        case "obtain_item": {
          const item = worldState.items.find((i) => i.id === o.itemId);
          label = `获取${item?.name ?? "某物"}`;
          completed = worldState.inventory.includes(o.itemId);
          break;
        }
        case "discover_fact": {
          const fact = worldState.worldFacts.find((f) => f.factId === o.factId);
          label = `发现${fact?.text ?? "秘密"}`;
          completed = fact?.discovered ?? false;
          break;
        }
        case "defeat_enemy": {
          const enemy = worldState.enemies.find((e) => e.id === o.enemyId);
          label = `击败${enemy?.name ?? "敌人"}`;
          completed = worldState.defeatedEnemyIds.includes(o.enemyId);
          break;
        }
      }
      return { label, completed };
    }),
  }));

  return {
    revision,
    gameType: worldState.generation.gameType,
    player: {
      name: worldState.player.name,
      identity: worldState.player.identity,
      hp: worldState.player.stats.hp,
      attack: worldState.player.stats.attack,
      defense: worldState.player.stats.defense,
    },
    currentLocation: {
      id: worldState.currentLocationId,
      name: currentLoc?.name ?? "???",
      description: currentLoc?.description ?? "",
    },
    availableNpcs: npcsHere.map((n) => ({ id: n.id, name: n.name, role: n.role, met: n.met })),
    availableMoves: moves,
    inventory: worldState.inventory.map((itemId) => {
      const item = worldState.items.find((i) => i.id === itemId);
      return { itemId: String(itemId), name: item?.name ?? "???" };
    }),
    story: {
      currentAct: storyState.currentAct,
      targetActs: storyState.targetActs,
      tension: storyState.tension,
      pacingNeed: storyState.nextPacingNeed,
      storyProgress: storyState.storyProgress,
    },
    narrative: {
      mode: storyState.narrative.mode,
      hasScene,
      npcDialogues,
      ...(hasScene && scene ? {
        eventKind: scene.event?.kind,
        narration: scene.narration,
        choices: scene.choices.map((c) => ({
          choiceToken: c.choiceToken,
          label: c.label,
          actionKey: c.actionKey,
        })),
        npcLine: scene.npcLine
          ? { npcId: String(scene.npcLine.npcId), text: scene.npcLine.text, emotion: scene.npcLine.emotion }
          : null,
      } : {}),
    },
    ...(storyState.narrative.generation.status === "pending"
      ? { narrativeGeneration: { status: "pending", totalApiCalls: 1 } }
      : {}),
    battle,
    quests,
    prologueShown: storyState.prologueShown,
    ending: worldState.ending ? { endingId: String(worldState.ending.endingId), outcome: worldState.ending.outcome } : null,
  };
}
