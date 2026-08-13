import type { Action } from "@/game/domain/action";
import {
  NPC_SCENE_PAGE_CHAR_BUDGET,
  composeDeterministicNpcLine,
} from "@/game/domain/narrative";
import { paginateSpeechText } from "@/game/domain/speechPagination";
import { locationScaleOf } from "@/game/domain/worldEntity";
import type { StoryState } from "@/game/domain/storyState";
import type { WorldState } from "@/game/domain/worldState";
import { buildChoiceMap, hasExplorableContent } from "./buildChoiceMap";
import { deriveRuntimeChoiceToken } from "./runtimeChoiceToken";
import { currentObjectiveOf } from "@/game/gameplay/rpg/narrativeContext";
import { buildTownView, type TownView } from "./townView";
import { projectCombatView, type BattleView } from "./combatView";
import { normalizeNpcSpeech } from "@/game/domain/npcSpeech";

export type PlayerChoiceView = {
  readonly choiceToken: string;
  readonly label: string;
  readonly hint?: string;
  readonly presentation: "dialogue" | "travel" | "explore" | "item" | "battle";
};

export type NpcDialogueView = {
  readonly npcId: string;
  readonly name: string;
  readonly role: string;
  readonly speechPages: readonly string[];
  readonly choices: readonly PlayerChoiceView[];
  readonly freeInputEnabled: boolean;
  /** 给予道具入口：焦点 NPC 可接收背包内任意物品（走正式 give_item 回合）。 */
  readonly giveChoices: readonly { readonly itemName: string; readonly choice: PlayerChoiceView }[];
  /** 非焦点 NPC 的闲聊：点击显示回复，不消耗回合。 */
  readonly smallTalk?: {
    readonly prompt: string;
    readonly response: string;
  };
};

type QuestObjectiveView = { readonly label: string; readonly completed: boolean };

export type GameSessionView = {
  readonly revision: number;
  /** 权威玩家回合数（storyState.turnNumber），用于 HUD 与试玩账本。 */
  readonly turnNumber: number;
  readonly gameType: string;
  /** 开局配置回显：旧存档无 setup 时字段均为 null。 */
  readonly setup: {
    readonly storyOpening: string | null;
    readonly worldPremise: string | null;
    readonly characterProfile: string | null;
    readonly narrativeStyle: string | null;
  };
  readonly player: {
    readonly name: string;
    readonly identity: string;
    readonly hp: number;
    readonly attack: number;
    readonly defense: number;
    readonly maxHp?: number;
    readonly maxEnergy?: number;
    readonly speed?: number;
  };
  readonly worldMap: {
    readonly locations: readonly {
      readonly name: string;
      readonly current: boolean;
      readonly visited: boolean;
      /** 地点层级：town/scene，UI 据此渲染小镇或场景视图。 */
      readonly scale: "town" | "scene";
      readonly travelChoice: PlayerChoiceView | null;
    }[];
  };
  readonly currentLocation: {
    readonly name: string;
    readonly description: string;
    readonly scale: "town" | "scene";
    readonly actions: readonly PlayerChoiceView[];
    /** 当前地点的 NPC 名单：小镇视图渲染居民/人物入口。 */
    readonly npcs: readonly {
      readonly name: string;
      readonly role: string;
      readonly talkChoice: PlayerChoiceView;
    }[];
    /** Task 7：scale="town" 地点的受控读模型（快照/标签/已绑定建筑条目），scene 为 null。 */
    readonly town: TownView | null;
  };
  readonly obtainableItems: readonly {
    readonly name: string;
    readonly description: string;
    readonly choice: PlayerChoiceView;
  }[];
  readonly inventory: readonly {
    readonly name: string;
    readonly description: string;
  }[];
  readonly story: {
    readonly currentAct: number;
    readonly targetActs: number;
    readonly tension: number;
    readonly pacingNeed: string;
    readonly storyProgress: number;
    /** Task 4：权威当前目标标签（与场景上下文 after.label 同源持久化状态）。 */
    readonly currentObjectiveLabel: string | null;
    /** 当前目标对应的世界行动 opaque token；目标不在当前地点时为 null。 */
    readonly currentObjectiveChoiceToken: string | null;
  };
  readonly narrative: {
    readonly mode: string;
    readonly hasScene: boolean;
    readonly eventKind?: string;
    readonly narration?: string;
    readonly choices: readonly PlayerChoiceView[];
    readonly npcLine: { readonly text: string; readonly emotion: string } | null;
    readonly npcDialogues: readonly NpcDialogueView[];
  };
  readonly narrativeGeneration: { readonly status: "idle" | "pending" };
  readonly battle: BattleView | null;
  readonly quests: readonly {
    readonly name: string;
    readonly description: string;
    readonly kind: string;
    readonly status: string;
    readonly objectives: readonly QuestObjectiveView[];
  }[];
  readonly prologueShown: boolean;
  /** 开局生成并审批通过的序幕文本；空串 = 生成失败，UI 回退玩家 storyOpening。 */
  readonly prologueText: string;
  readonly ending: {
    readonly name: string;
    readonly description: string;
    readonly outcome: string;
    readonly restartIdentity: string;
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

/**
 * 非焦点 NPC 的展示层闲聊兜底。
 *
 * 场景表演源可以提供更贴合上下文的 smallTalk；当 live/fallback 场景
 * 没有附带时，仍给玩家一个不消耗回合的轻交互入口。文本只描述无状态
 * 影响的环境闲话，不授予事实、不推进任务，也不替代正式 talk action。
 */
function buildSmallTalkFallback(npc: { readonly name: string; readonly role: string }): {
  readonly prompt: string;
  readonly response: string;
} {
  return {
    prompt: `和${npc.name}聊几句`,
    response: `先看看周围，别急着下结论。`,
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
    case "give_item":
      return "item";
    case "attack":
    case "battle_action":
      return "battle";
    case "explore":
    case "investigate":
    case "ack_prologue":
      return "explore";
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

function currentObjectiveChoiceToken(
  worldState: WorldState,
  objective: WorldState["quests"][number]["objectives"][number] | undefined,
  revision: number,
): string | null {
  if (objective === undefined) return null;

  switch (objective.kind) {
    case "visit_location": {
      const currentLocation = worldState.locations.find((entry) => entry.id === worldState.currentLocationId);
      if (
        currentLocation === undefined
        || objective.locationId === worldState.currentLocationId
        || !currentLocation.connectedLocationIds.includes(objective.locationId)
        || !worldState.unlockedLocationIds.includes(objective.locationId)
      ) return null;
      return choice(
        { type: "move", locationId: objective.locationId },
        revision,
        "前往目标地点",
        "travel",
      ).choiceToken;
    }
    case "talk_to_npc": {
      const npc = worldState.npcs.find((entry) => entry.id === objective.npcId);
      return npc?.locationId === worldState.currentLocationId
        ? choice({ type: "talk", npcId: npc.id, dialogueAct: "ask" }, revision, "与目标人物交谈", "dialogue").choiceToken
        : null;
    }
    case "obtain_item": {
      const currentLocation = worldState.locations.find((entry) => entry.id === worldState.currentLocationId);
      return currentLocation?.availableItemIds.includes(objective.itemId) === true
        && !worldState.inventory.includes(objective.itemId)
        ? choice({ type: "take_item", itemId: objective.itemId }, revision, "拾取目标物品", "item").choiceToken
        : null;
    }
    case "discover_fact": {
      const fact = worldState.worldFacts.find((entry) => entry.factId === objective.factId);
      return fact?.locationId === worldState.currentLocationId && !fact.discovered
        ? choice({ type: "investigate", factId: fact.factId }, revision, "调查目标线索", "explore").choiceToken
        : null;
    }
    case "defeat_enemy": {
      const enemy = worldState.enemies.find((entry) => entry.id === objective.enemyId);
      return enemy?.locationId === worldState.currentLocationId
        && !worldState.defeatedEnemyIds.includes(objective.enemyId)
        ? choice({ type: "attack", enemyId: enemy.id }, revision, "挑战目标敌人", "battle").choiceToken
        : null;
    }
  }
}

export function projectGameSessionView(
  worldState: WorldState,
  storyState: StoryState,
  revision: number,
  endingSessionIdentity: string,
): GameSessionView {
  const currentLocation = worldState.locations.find((entry) => entry.id === worldState.currentLocationId);
  const presentNpcs = worldState.npcs.filter((entry) => entry.locationId === worldState.currentLocationId);
  const activeBattle = worldState.battle.status === "active" ? worldState.battle : null;
  const currentObjectiveRef = currentObjectiveOf(worldState, storyState);
  const currentObjectiveQuest = currentObjectiveRef === null
    ? undefined
    : worldState.quests.find((quest) => String(quest.id) === String(currentObjectiveRef.questId));
  const currentObjective = currentObjectiveRef === null
    ? undefined
    : currentObjectiveQuest?.objectives[currentObjectiveRef.objectiveIndex];
  const currentObjectiveToken = currentObjectiveChoiceToken(worldState, currentObjective, revision);

  const travelTargets = new Set(
    activeBattle === null ? currentLocation?.connectedLocationIds ?? [] : [],
  );
  const mapLocations = worldState.locations
    .filter((location) => worldState.unlockedLocationIds.includes(location.id))
    .map((location) => ({
      name: location.name,
      current: location.id === worldState.currentLocationId,
      visited: worldState.visitedLocationIds.includes(location.id),
      scale: locationScaleOf(location),
      travelChoice: travelTargets.has(location.id)
        ? choice({ type: "move", locationId: location.id }, revision, `前往${location.name}`, "travel")
        : null,
    }));

  const locationActions: PlayerChoiceView[] = [];
  if (activeBattle === null) {
    // 探索：仅当前地点有可探索内容（未发现线索/未处理物品或敌人/未满足目标/候选事件）
    // 时显示，避免无剧情钩子地点的空转选项（方案 1）。
    if (hasExplorableContent(worldState, storyState)) {
      locationActions.push(choice({ type: "explore" }, revision, `探索${currentLocation?.name ?? "此地"}`, "explore"));
    }
    const undiscoveredFacts = worldState.worldFacts.filter((fact) =>
      fact.locationId === worldState.currentLocationId && !fact.discovered,
    );
    for (const [index, fact] of undiscoveredFacts.entries()) {
      if (fact.locationId === worldState.currentLocationId && !fact.discovered) {
        const suffix = undiscoveredFacts.length > 1 ? ` ${index + 1}` : "";
        locationActions.push(choice({ type: "investigate", factId: fact.factId }, revision, `调查现场线索${suffix}`, "explore"));
      }
    }
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
  }

  const obtainableItems = activeBattle === null
    ? (currentLocation?.availableItemIds ?? [])
      .filter((itemId) => !worldState.inventory.includes(itemId))
      .map((itemId) => {
        const item = worldState.items.find((entry) => entry.id === itemId);
        return {
          name: item?.name ?? "未知物品",
          description: item?.description ?? "",
          choice: choice({ type: "take_item", itemId }, revision, `拾取${item?.name ?? "物品"}`, "item"),
        };
      })
    : [];

  const scene = storyState.narrative.currentScene;
  const currentObjectiveNpcId = currentObjective?.kind === "talk_to_npc"
    ? String(currentObjective.npcId)
    : null;
  // 只有结构化 dialogue event 才能赋予 NPC“焦点对话”能力。
  // observe/travel 等场景也可能带 npcLine 作为旁白表演，但不能因此泄露
  // 自由输入或伪造一个没有两个批准选项的焦点对话框。
  const persistedFocusNpcId = scene?.event?.kind === "dialogue"
    ? String(scene.event.focusNpcId)
    : null;
  // 兼容已经写入本地存档的旧交接场景：若权威当前目标明确要求与另一名
  // 在场 NPC 交谈，旧 scene 的 focus/choices 已经过期。将旧 NPC 降为普通
  // 交谈入口，避免继续消费同一组 support/challenge token。
  const persistedFocusNpc = persistedFocusNpcId === null
    ? undefined
    : presentNpcs.find((npc) => String(npc.id) === persistedFocusNpcId);
  const latestFocusDialogueAct = persistedFocusNpc?.memory.interactionHistory.at(-1)?.dialogueAct;
  const staleDialogueFocus = persistedFocusNpcId !== null
    && currentObjectiveNpcId !== null
    && currentObjectiveNpcId !== persistedFocusNpcId
    && presentNpcs.some((npc) => String(npc.id) === currentObjectiveNpcId)
    && latestFocusDialogueAct !== "ask";
  const focusNpcId = staleDialogueFocus ? null : persistedFocusNpcId;
  const registry = storyState.narrative.choiceRegistry ?? [];
  const legalChoiceMap = buildChoiceMap(worldState, storyState, revision);
  const projectSceneChoice = (sceneChoice: NonNullable<typeof scene>["choices"][number]): PlayerChoiceView | null => {
    const approved = registry.find((entry) =>
      entry.choiceToken === sceneChoice.choiceToken
      && entry.sceneId === scene?.sceneId
      && entry.basedOnRevision === revision
    );
    if (
      approved === undefined
      || legalChoiceMap.get(sceneChoice.choiceToken) !== approved.action
    ) {
      return null;
    }
    return {
      choiceToken: sceneChoice.choiceToken,
      label: approved.label,
      ...(sceneChoice.hint === undefined ? {} : { hint: sceneChoice.hint }),
      presentation: presentationForAction(approved.action),
    };
  };
  const projectedSceneChoices = staleDialogueFocus
    ? []
    : scene?.choices
      .map(projectSceneChoice)
      .filter((entry): entry is PlayerChoiceView => entry !== null) ?? [];
  const isDialogueScene = focusNpcId !== null;
  const dialogueChoices: NpcDialogueView["choices"] = isDialogueScene && projectedSceneChoices.length === 2
    ? [projectedSceneChoices[0]!, projectedSceneChoices[1]!]
    : [];
  const sceneDialogues = new Map((scene?.npcDialogues ?? []).map((entry) => [String(entry.npcId), entry]));
  const npcDialogues: readonly NpcDialogueView[] = presentNpcs.flatMap((npc) => {
    const isFocus = focusNpcId === String(npc.id);
    const supplied = sceneDialogues.get(String(npc.id));
    const normalizedFocusLine = scene?.npcLine !== null
      && scene?.npcLine !== undefined
      && scene.npcLine.npcId === npc.id
      && scene.npcLine.text.trim() !== ""
      ? normalizeNpcSpeech(scene.npcLine.text, npc.name)
      : null;
    const focusLine = normalizedFocusLine === "" ? null : normalizedFocusLine;
    // 非焦点 NPC 若没有场景供给的台词，不渲染千篇一律的模板招呼面板。
    if (!isFocus && supplied === undefined && focusLine === null) return [];
    const suppliedSpeechPages = supplied?.speechPages
      .map((page) => normalizeNpcSpeech(page, npc.name))
      .filter((page) => page !== "") ?? [];
    const speechPages = suppliedSpeechPages.length > 0
      ? suppliedSpeechPages
      : paginateSpeechText(focusLine ?? composeDeterministicNpcLine(npc.name, npc.role), NPC_SCENE_PAGE_CHAR_BUDGET);
    const smallTalkData = supplied?.smallTalk ?? buildSmallTalkFallback(npc);
    // 非焦点 NPC 的场景台词也必须能转化为一次真实交谈：点击后提交 ask，
    // 下一回合再由规则把该 NPC 设为焦点并生成两项回应 + 自由输入。
    const fallbackTalkChoice = choice(
      { type: "talk", npcId: npc.id, dialogueAct: "ask" },
      revision,
      `与${npc.name}交谈`,
      "dialogue",
    );
    return [{
      npcId: String(npc.id),
      name: npc.name,
      role: npc.role,
      speechPages,
      choices: isFocus ? dialogueChoices : [fallbackTalkChoice],
      freeInputEnabled: isFocus,
      giveChoices: isFocus
        ? worldState.inventory.map((itemId) => {
            const item = worldState.items.find((entry) => entry.id === itemId);
            const itemName = item?.name ?? "未知物品";
            return {
              itemName,
              choice: choice(
                { type: "give_item", itemId, npcId: npc.id },
                revision,
                `把${itemName}交给${npc.name}`,
                "item",
              ),
            };
          })
        : [],
      ...(!isFocus
        ? {
            smallTalk: {
              prompt: smallTalkData.prompt,
              response: normalizeNpcSpeech(smallTalkData.response, npc.name)
                || composeDeterministicNpcLine(npc.name, npc.role),
            },
          }
        : {}),
    }];
  });

  const battle = activeBattle === null ? null : projectCombatView(worldState, activeBattle, revision);
  const sceneNpc = scene?.npcLine === null || scene?.npcLine === undefined
    ? undefined
    : presentNpcs.find((npc) => String(npc.id) === String(scene.npcLine?.npcId));
  const projectedNpcLine = scene?.npcLine === null || scene?.npcLine === undefined
    ? null
    : {
        text: normalizeNpcSpeech(scene.npcLine.text, sceneNpc?.name),
        emotion: scene.npcLine.emotion,
      };
  const endingDefinition = worldState.ending === null
    ? undefined
    : worldState.endings.find((entry) => entry.id === worldState.ending?.endingId);

  return {
    revision,
    turnNumber: storyState.turnNumber,
    gameType: worldState.generation.gameType,
    setup: {
      storyOpening: worldState.generation.setup?.storyOpening ?? null,
      worldPremise: worldState.generation.setup?.worldPremise ?? null,
      characterProfile: worldState.generation.setup?.characterProfile ?? null,
      narrativeStyle: worldState.generation.setup?.narrativeStyle ?? null,
    },
    player: {
      name: worldState.player.name,
      identity: worldState.player.identity,
      hp: worldState.player.stats.hp,
      attack: worldState.player.stats.attack,
      defense: worldState.player.stats.defense,
      maxHp: worldState.player.stats.maxHp ?? worldState.player.stats.hp,
      maxEnergy: worldState.player.stats.maxEnergy,
      speed: worldState.player.stats.speed,
    },
    worldMap: { locations: mapLocations },
    currentLocation: {
      name: currentLocation?.name ?? "未知地点",
      description: currentLocation?.description ?? "",
      scale: currentLocation === undefined ? "scene" : locationScaleOf(currentLocation),
      actions: locationActions,
      npcs: presentNpcs.map((npc) => ({
        name: npc.name,
        role: npc.role,
        talkChoice: choice(
          { type: "talk", npcId: npc.id, dialogueAct: "ask" },
          revision,
          `与${npc.name}交谈`,
          "dialogue",
        ),
      })),
      town: currentLocation !== undefined
        ? buildTownView(worldState, currentLocation.id)
        : null,
    },
    obtainableItems,
    inventory: worldState.inventory.map((itemId) => {
      const item = worldState.items.find((entry) => entry.id === itemId);
      return { name: item?.name ?? "未知物品", description: item?.description ?? "" };
    }),
    story: {
      currentAct: storyState.currentAct,
      targetActs: storyState.targetActs,
      tension: storyState.tension,
      pacingNeed: storyState.nextPacingNeed,
      storyProgress: storyState.storyProgress,
      currentObjectiveLabel: currentObjectiveRef?.label ?? null,
      currentObjectiveChoiceToken: currentObjectiveToken,
    },
    narrative: {
      mode: storyState.narrative.mode,
      hasScene: scene !== null,
      ...(scene === null ? {} : { eventKind: scene.event?.kind, narration: scene.narration }),
      choices: isDialogueScene ? [] : projectedSceneChoices,
      npcLine: projectedNpcLine,
      npcDialogues,
    },
    narrativeGeneration: { status: storyState.narrative.generation.status },
    battle,
    quests: worldState.quests.map((quest) => ({
      name: quest.name,
      description: quest.description,
      kind: quest.kind,
      status: quest.status,
      objectives: projectQuestObjectives(worldState, quest.objectives),
    })),
    prologueShown: storyState.prologueShown,
    prologueText: storyState.prologueText,
    ending: worldState.ending === null ? null : {
      name: endingDefinition?.name ?? "故事结局",
      description: endingDefinition?.description ?? "",
      outcome: worldState.ending.outcome,
      restartIdentity: endingSessionIdentity,
    },
  };
}
