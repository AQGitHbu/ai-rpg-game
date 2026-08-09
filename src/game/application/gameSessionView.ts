import type { Action } from "@/game/domain/action";
import {
  NPC_SCENE_PAGE_CHAR_BUDGET,
  composeDeterministicNpcLine,
  paginateSpeechText,
} from "@/game/domain";
import type { StoryState } from "@/game/domain/storyState";
import type { WorldState } from "@/game/domain/worldState";
import { deriveRuntimeChoiceToken } from "./runtimeChoiceToken";

export type PlayerChoiceView = {
  readonly choiceToken: string;
  readonly label: string;
  readonly hint?: string;
  readonly presentation: "dialogue" | "travel" | "explore" | "item" | "battle" | "rest";
};

export type NpcDialogueView = {
  readonly npcId: string;
  readonly name: string;
  readonly role: string;
  readonly speechPages: readonly string[];
  readonly choices: readonly [PlayerChoiceView, PlayerChoiceView] | readonly [];
  readonly freeInputEnabled: boolean;
};

type QuestObjectiveView = { readonly label: string; readonly completed: boolean };

export type GameSessionView = {
  readonly revision: number;
  readonly gameType: string;
  readonly player: {
    readonly name: string;
    readonly identity: string;
    readonly hp: number;
    readonly attack: number;
    readonly defense: number;
  };
  readonly worldMap: {
    readonly locations: readonly {
      readonly id: string;
      readonly name: string;
      readonly current: boolean;
      readonly visited: boolean;
      readonly travelChoice: PlayerChoiceView | null;
    }[];
  };
  readonly currentLocation: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly actions: readonly PlayerChoiceView[];
  };
  readonly obtainableItems: readonly {
    readonly itemId: string;
    readonly name: string;
    readonly description: string;
    readonly choice: PlayerChoiceView;
  }[];
  readonly inventory: readonly {
    readonly itemId: string;
    readonly name: string;
    readonly description: string;
  }[];
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
    readonly choices: readonly PlayerChoiceView[];
    readonly npcLine: { readonly npcId: string; readonly text: string; readonly emotion: string } | null;
    readonly npcDialogues: readonly NpcDialogueView[];
  };
  readonly narrativeGeneration: { readonly status: "idle" | "pending" };
  readonly battle: {
    readonly enemyName: string;
    readonly playerHp: number;
    readonly enemyHp: number;
    readonly round: number;
    readonly controls: readonly PlayerChoiceView[];
  } | null;
  readonly quests: readonly {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly kind: string;
    readonly status: string;
    readonly objectives: readonly QuestObjectiveView[];
  }[];
  readonly prologueShown: boolean;
  readonly ending: {
    readonly endingId: string;
    readonly name: string;
    readonly description: string;
    readonly outcome: string;
  } | null;
};

function choice(
  action: Action,
  revision: number,
  label: string,
  presentation: PlayerChoiceView["presentation"],
  hint?: string,
): PlayerChoiceView {
  return {
    choiceToken: deriveRuntimeChoiceToken(action, revision),
    label,
    ...(hint === undefined ? {} : { hint }),
    presentation,
  };
}

function presentationForAction(action: Action): PlayerChoiceView["presentation"] {
  switch (action.type) {
    case "talk":
    case "freeform":
      return "dialogue";
    case "move":
      return "travel";
    case "take_item":
      return "item";
    case "attack":
    case "battle_action":
      return "battle";
    case "rest":
      return "rest";
    case "explore":
    case "investigate":
    case "ack_prologue":
      return "explore";
  }
}

function fallbackScenePresentation(
  kind: string | undefined,
): PlayerChoiceView["presentation"] {
  switch (kind) {
    case "dialogue": return "dialogue";
    case "travel": return "travel";
    case "item": return "item";
    case "battle": return "battle";
    default: return "explore";
  }
}

function projectQuestObjectives(worldState: WorldState, objectives: WorldState["quests"][number]["objectives"]): readonly QuestObjectiveView[] {
  return objectives.map((objective) => {
    switch (objective.kind) {
      case "visit_location": {
        const location = worldState.locations.find((entry) => entry.id === objective.locationId);
        return { label: `前往${location?.name ?? "未知地点"}`, completed: worldState.visitedLocationIds.includes(objective.locationId) };
      }
      case "talk_to_npc": {
        const npc = worldState.npcs.find((entry) => entry.id === objective.npcId);
        return { label: `与${npc?.name ?? "某人"}交谈`, completed: npc?.met ?? false };
      }
      case "obtain_item": {
        const item = worldState.items.find((entry) => entry.id === objective.itemId);
        return { label: `获取${item?.name ?? "某物"}`, completed: worldState.inventory.includes(objective.itemId) };
      }
      case "discover_fact": {
        const fact = worldState.worldFacts.find((entry) => entry.factId === objective.factId);
        return {
          label: fact?.discovered === true ? `发现${fact.text}` : "发现秘密",
          completed: fact?.discovered === true,
        };
      }
      case "defeat_enemy": {
        const enemy = worldState.enemies.find((entry) => entry.id === objective.enemyId);
        return { label: `击败${enemy?.name ?? "敌人"}`, completed: worldState.defeatedEnemyIds.includes(objective.enemyId) };
      }
    }
  });
}

export function projectGameSessionView(
  worldState: WorldState,
  storyState: StoryState,
  revision: number,
): GameSessionView {
  const currentLocation = worldState.locations.find((entry) => entry.id === worldState.currentLocationId);
  const presentNpcs = worldState.npcs.filter((entry) => entry.locationId === worldState.currentLocationId);
  const activeBattle = worldState.battle.status === "active" ? worldState.battle : null;

  const travelTargets = new Set(
    activeBattle === null ? currentLocation?.connectedLocationIds ?? [] : [],
  );
  const mapLocations = worldState.locations
    .filter((location) => worldState.unlockedLocationIds.includes(location.id))
    .map((location) => ({
      id: String(location.id),
      name: location.name,
      current: location.id === worldState.currentLocationId,
      visited: worldState.visitedLocationIds.includes(location.id),
      travelChoice: travelTargets.has(location.id)
        ? choice({ type: "move", locationId: location.id }, revision, `前往${location.name}`, "travel")
        : null,
    }));

  const locationActions: PlayerChoiceView[] = [];
  if (activeBattle === null) {
    locationActions.push(choice({ type: "explore" }, revision, `探索${currentLocation?.name ?? "此地"}`, "explore"));
    for (const npc of presentNpcs) {
      locationActions.push(choice(
        { type: "talk", npcId: npc.id, dialogueAct: "ask" },
        revision,
        `与${npc.name}交谈`,
        "dialogue",
      ));
    }
    for (const enemy of worldState.enemies) {
      if (enemy.locationId === worldState.currentLocationId && !worldState.defeatedEnemyIds.includes(enemy.id)) {
        locationActions.push(choice({ type: "attack", enemyId: enemy.id }, revision, `挑战${enemy.name}`, "battle"));
      }
    }
    locationActions.push(choice({ type: "rest" }, revision, "休息", "rest"));
  }

  const obtainableItems = activeBattle === null
    ? (currentLocation?.availableItemIds ?? [])
      .filter((itemId) => !worldState.inventory.includes(itemId))
      .map((itemId) => {
        const item = worldState.items.find((entry) => entry.id === itemId);
        return {
          itemId: String(itemId),
          name: item?.name ?? "未知物品",
          description: item?.description ?? "",
          choice: choice({ type: "take_item", itemId }, revision, `拾取${item?.name ?? "物品"}`, "item"),
        };
      })
    : [];

  const scene = storyState.narrative.currentScene;
  const focusNpcId = scene?.event?.kind === "dialogue"
    ? String(scene.event.focusNpcId)
    : scene?.npcLine === null || scene?.npcLine === undefined
      ? null
      : String(scene.npcLine.npcId);
  const registry = storyState.narrative.choiceRegistry ?? [];
  const projectSceneChoice = (sceneChoice: NonNullable<typeof scene>["choices"][number]): PlayerChoiceView => {
    const approved = registry.find((entry) =>
      entry.choiceToken === sceneChoice.choiceToken
      && entry.sceneId === scene?.sceneId
      && entry.basedOnRevision === revision
    );
    return {
      choiceToken: sceneChoice.choiceToken,
      label: sceneChoice.label,
      ...(sceneChoice.hint === undefined ? {} : { hint: sceneChoice.hint }),
      presentation: approved === undefined
        ? fallbackScenePresentation(scene?.event?.kind)
        : presentationForAction(approved.action),
    };
  };
  const projectedSceneChoices = scene?.choices.map(projectSceneChoice) ?? [];
  const isDialogueScene = focusNpcId !== null;
  const dialogueChoices: NpcDialogueView["choices"] = isDialogueScene && projectedSceneChoices.length === 2
    ? [projectedSceneChoices[0]!, projectedSceneChoices[1]!]
    : [];
  const sceneDialogues = new Map((scene?.npcDialogues ?? []).map((entry) => [String(entry.npcId), entry]));
  const npcDialogues: readonly NpcDialogueView[] = presentNpcs.map((npc) => {
    const isFocus = focusNpcId === String(npc.id);
    const supplied = sceneDialogues.get(String(npc.id));
    const focusLine = scene?.npcLine !== null
      && scene?.npcLine !== undefined
      && scene.npcLine.npcId === npc.id
      && scene.npcLine.text.trim() !== ""
      ? scene.npcLine.text.trim()
      : null;
    const speechPages = supplied !== undefined && supplied.speechPages.length > 0
      ? [...supplied.speechPages]
      : paginateSpeechText(focusLine ?? composeDeterministicNpcLine(npc.name, npc.role), NPC_SCENE_PAGE_CHAR_BUDGET);
    return {
      npcId: String(npc.id),
      name: npc.name,
      role: npc.role,
      speechPages,
      choices: isFocus ? dialogueChoices : [],
      freeInputEnabled: isFocus,
    };
  });

  const battle = activeBattle === null ? null : {
    enemyName: worldState.enemies.find((entry) => entry.id === activeBattle.enemyId)?.name ?? "未知敌人",
    playerHp: activeBattle.playerHp,
    enemyHp: activeBattle.enemyHp,
    round: activeBattle.round,
    controls: [
      choice({ type: "battle_action", action: "attack" }, revision, "攻击", "battle"),
      choice({ type: "battle_action", action: "guard" }, revision, "防御", "battle"),
      choice({ type: "battle_action", action: "flee" }, revision, "撤退", "battle"),
    ],
  };
  const endingDefinition = worldState.ending === null
    ? undefined
    : worldState.endings.find((entry) => entry.id === worldState.ending?.endingId);

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
    worldMap: { locations: mapLocations },
    currentLocation: {
      id: String(worldState.currentLocationId),
      name: currentLocation?.name ?? "未知地点",
      description: currentLocation?.description ?? "",
      actions: locationActions,
    },
    obtainableItems,
    inventory: worldState.inventory.map((itemId) => {
      const item = worldState.items.find((entry) => entry.id === itemId);
      return { itemId: String(itemId), name: item?.name ?? "未知物品", description: item?.description ?? "" };
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
      hasScene: scene !== null,
      ...(scene === null ? {} : { eventKind: scene.event?.kind, narration: scene.narration }),
      choices: isDialogueScene ? [] : projectedSceneChoices,
      npcLine: scene?.npcLine === null || scene?.npcLine === undefined
        ? null
        : { npcId: String(scene.npcLine.npcId), text: scene.npcLine.text, emotion: scene.npcLine.emotion },
      npcDialogues,
    },
    narrativeGeneration: { status: storyState.narrative.generation.status },
    battle,
    quests: worldState.quests.map((quest) => ({
      id: String(quest.id),
      name: quest.name,
      description: quest.description,
      kind: quest.kind,
      status: quest.status,
      objectives: projectQuestObjectives(worldState, quest.objectives),
    })),
    prologueShown: storyState.prologueShown,
    ending: worldState.ending === null ? null : {
      endingId: String(worldState.ending.endingId),
      name: endingDefinition?.name ?? "故事结局",
      description: endingDefinition?.description ?? "",
      outcome: worldState.ending.outcome,
    },
  };
}
