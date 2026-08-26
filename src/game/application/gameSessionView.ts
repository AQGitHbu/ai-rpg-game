import type { Action } from "@/game/domain/action";
import type { ApprovedChoice } from "@/game/domain/approvedChoice";
import {
  NPC_SCENE_PAGE_CHAR_BUDGET,
  composeDeterministicNpcLine,
} from "@/game/domain/narrative";
import type { DialogueResumeState, NarrativeSceneState } from "@/game/domain/narrative";
import { paginateSpeechText } from "@/game/domain/speechPagination";
import { locationScaleOf } from "@/game/domain/worldEntity";
import type { ItemCategory, ItemRarity, ItemStatLine } from "@/game/domain/worldEntity";
import { resolveItemPresentation, type ItemIconKey } from "@/game/domain/itemPresentation";
import type { StoryState } from "@/game/domain/storyState";
import { isTravelTarget, type WorldState } from "@/game/domain/worldState";
import type { AiFailureKind } from "@/game/domain/narrativeGenerationFailure";
import {
  buildChoiceMap,
  hasExplorableContent,
  needsWorldBoundaryPreparation,
  townBuildingInvestigationTargetNpcId,
} from "./buildChoiceMap";
import { deriveRuntimeChoiceToken } from "./runtimeChoiceToken";
import { currentObjectiveOf } from "@/game/gameplay/rpg/narrativeContext";
import { isObjectiveSatisfied } from "@/game/gameplay/rpg/narrativeContext/objectiveRules";
import { buildTownView, type TownView } from "./townView";
import { projectCombatView, type BattleView } from "./combatView";
import { composeDirectNpcGreeting, composeIdleNpcLine, normalizeNpcSpeech } from "@/game/domain/npcSpeech";
import { isObjectiveEntityReleased, isQuestObjectiveReleased } from "@/game/gameplay/rpg/worldEvolution";
import { formatSceneChoiceLabel } from "./deterministicSceneSource";
import { decorateNarrativePages, decorateNarrativeText } from "./narrativeText";

export type PlayerChoiceView = {
  readonly choiceToken: string;
  readonly label: string;
  readonly hint?: string;
  readonly presentation: "dialogue" | "travel" | "explore" | "item" | "battle" | "investigate";
};

export type NpcDialogueView = {
  readonly npcId: string;
  readonly name: string;
  readonly role: string;
  readonly speechPages: readonly string[];
  /** 正式对白收尾的本地确认句；不携带 choice token、action 或 revision。 */
  readonly handoffAcknowledgement?: { readonly label: string };
  /** 旧存档缺少已准备抵达对白时，用当前权威 talk action 触发一次补生成。 */
  readonly startChoice?: PlayerChoiceView;
  readonly choices: readonly PlayerChoiceView[];
  readonly freeInputEnabled: boolean;
  /** 给予道具入口：焦点 NPC 可接收背包内任意物品（走正式 give_item 回合）。 */
  readonly giveChoices: readonly { readonly itemName: string; readonly choice: PlayerChoiceView }[];
};

/**
 * 背包安全展示视图：只暴露玩家可见文本和展示元数据，不暴露 itemId、kind 或 tags。
 * category/rarity 等字段不参与任何规则结算。
 */
export type InventoryItemView = {
  readonly name: string;
  readonly description: string;
  readonly category: ItemCategory;
  readonly rarity: ItemRarity;
  readonly level: number | null;
  readonly statLines: readonly ItemStatLine[];
  readonly icon: ItemIconKey;
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
      readonly npcId: string;
      readonly name: string;
      readonly role: string;
      readonly talkChoice: PlayerChoiceView | null;
    }[];
    /** Task 7：scale="town" 地点的受控读模型（快照/标签/已绑定建筑条目），scene 为 null。 */
    readonly town: TownView | null;
  };
  readonly obtainableItems: readonly {
    readonly name: string;
    readonly description: string;
    /** 城镇地点中的物品只属于一个可进入的剧情建筑；scene 地点不设置。 */
    readonly buildingId?: string;
    readonly choice: PlayerChoiceView;
  }[];
  readonly inventory: readonly InventoryItemView[];
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
    /** 当前目标的全部权威行动 token；discover_fact 自动确认，因此不生成 token。 */
    readonly currentObjectiveChoiceTokens: readonly string[];
  };
  readonly narrative: {
    readonly mode: string;
    readonly hasScene: boolean;
    readonly eventKind?: string;
    readonly narration?: string;
    readonly choices: readonly PlayerChoiceView[];
    readonly npcLine: { readonly text: string; readonly emotion: string; readonly speaker?: string } | null;
    readonly npcDialogues: readonly NpcDialogueView[];
  };
  readonly narrativeGeneration:
    | { readonly status: "idle" }
    | { readonly status: "pending"; readonly jobKey: string }
    | { readonly status: "failed"; readonly failureKind?: AiFailureKind; readonly jobKey: string };
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
    case "investigate":
      return "investigate";
    case "explore":
    case "ack_prologue":
      return "explore";
  }
}

function restoreDialogueResume(
  resume: DialogueResumeState,
  revision: number,
): { readonly scene: NarrativeSceneState; readonly choiceRegistry: readonly ApprovedChoice[] } | null {
  const entries = resume.scene.choices
    .map((sceneChoice) => resume.choiceRegistry.find((entry) =>
      entry.choiceToken === sceneChoice.choiceToken
      && entry.sceneId === resume.scene.sceneId,
    ))
    .filter((entry): entry is ApprovedChoice => entry !== undefined);
  if (entries.length !== resume.scene.choices.length) return null;
  if (entries.some((entry) => {
    if (entry.action.type !== "talk") return true;
    return String(entry.action.npcId) !== String(resume.npcId);
  })) return null;

  const sceneId = `scene-resume-dialogue-${resume.npcId}-${revision}`;
  const choiceRegistry = entries.map((entry) => ({
    ...entry,
    choiceToken: deriveRuntimeChoiceToken(entry.action, revision),
    sceneId,
    basedOnRevision: revision,
  }));
  const choices = resume.scene.choices.map((sceneChoice, index) => ({
    ...sceneChoice,
    choiceToken: choiceRegistry[index]!.choiceToken,
  }));
  return {
    scene: {
      ...resume.scene,
      sceneId,
      turn: revision,
      choices,
    },
    choiceRegistry,
  };
}

function projectQuestObjectives(
  worldState: WorldState,
  storyState: StoryState,
  questId: string,
  objectives: WorldState["quests"][number]["objectives"],
): readonly QuestObjectiveView[] {
  return objectives
    .filter((_objective, index) => isQuestObjectiveReleased(storyState, questId, index))
    .map((objective) => {
    switch (objective.kind) {
      case "visit_location": {
        const location = worldState.locations.find((entry) => entry.id === objective.locationId);
        return { label: `前往${location?.name ?? "未知地点"}`, completed: worldState.visitedLocationIds.includes(objective.locationId) };
      }
      case "talk_to_npc": {
        const npc = worldState.npcs.find((entry) => entry.id === objective.npcId);
        const dialogueSession = storyState.narrative.dialogueSession;
        const sessionIsForNpc = dialogueSession !== undefined
          && String(dialogueSession.npcId) === String(objective.npcId);
        const completed = sessionIsForNpc
          ? dialogueSession.completed && (npc?.met ?? false)
          : (npc?.met ?? false);
        return { label: `与${npc?.name ?? "某人"}交谈`, completed };
      }
      case "obtain_item": {
        const item = worldState.items.find((entry) => entry.id === objective.itemId);
        return { label: `获取${item?.name ?? "某物"}`, completed: isObjectiveSatisfied(worldState, objective) };
      }
      case "discover_fact": {
        const fact = worldState.worldFacts.find((entry) => entry.factId === objective.factId);
        return {
          label: fact?.discovered === true
            ? `查明：${fact.text}`
            : `调查${fact?.investigationLabel ?? "现场线索"}`,
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
  storyState: StoryState,
  objective: WorldState["quests"][number]["objectives"][number] | undefined,
  revision: number,
): string | null {
  if (objective === undefined) return null;

  switch (objective.kind) {
    case "visit_location": {
      const currentLocation = worldState.locations.find((entry) => entry.id === worldState.currentLocationId);
      if (currentLocation === undefined || !isTravelTarget(worldState, objective.locationId)) return null;
      // 对话回合完成 talk 目标后，AI 可能在交接场景预生成指向下一地点的
      // move 选项（scene scope token，与 runtime token 派生自不同 sceneId，
      // 永不相等）。保留该 token 供 handoff/旁注识别；真正移动入口由地图层承载。
      const readyNarrative = storyState.narrative.status === "ready"
        ? storyState.narrative
        : null;
      if (readyNarrative !== null) {
        const scene = readyNarrative.currentScene;
        const registry = readyNarrative.choiceRegistry;
        for (const sceneChoice of scene.choices) {
          const approved = registry.find((entry) =>
            entry.choiceToken === sceneChoice.choiceToken
            && entry.sceneId === scene.sceneId
            && entry.basedOnRevision === revision
            && entry.action.type === "move"
            && String(entry.action.locationId) === String(objective.locationId),
          );
          if (approved !== undefined) return sceneChoice.choiceToken;
        }
      }
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
      // 事实在规则边界自动确认，不再生成调查按钮。
      return null;
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
  const presentNpcs = worldState.npcs.filter((entry) =>
    entry.locationId === worldState.currentLocationId
    && isObjectiveEntityReleased(worldState, storyState, (objective) =>
      objective.kind === "talk_to_npc" && String(objective.npcId) === String(entry.id)),
  );
  const activeBattle = worldState.battle.status === "active" ? worldState.battle : null;
  const currentObjectiveRef = currentObjectiveOf(worldState, storyState);
  const currentObjectiveQuest = currentObjectiveRef === null
    ? undefined
    : worldState.quests.find((quest) => String(quest.id) === String(currentObjectiveRef.questId));
  const currentObjective = currentObjectiveRef === null
    ? undefined
    : currentObjectiveQuest?.objectives[currentObjectiveRef.objectiveIndex];
  // 终幕结局对已经物化、且玩家尚未作出最后立场时，任务链本身没有未完成
  // objective。仍需向 HUD 投影一个权威目标，避免玩家看到“暂无线索”后
  // 只能靠点击 NPC 试探性地触发下一段对白。
  const endingDecisionReady = storyState.endingAllowed
    && worldState.ending === null
    && worldState.endings.length >= 2;
  const currentObjectiveToken = currentObjectiveChoiceToken(worldState, storyState, currentObjective, revision);
  // discover_fact 由规则边界自动确认；其余目标保持单一兼容 token。
  const currentObjectiveTokens = currentObjectiveToken === null ? [] : [currentObjectiveToken];
  const currentObjectiveNpcId = currentObjective?.kind === "talk_to_npc"
    ? String(currentObjective.npcId)
    : null;
  const townView = currentLocation === undefined
    ? null
    : buildTownView(worldState, currentLocation.id, currentObjectiveNpcId);
  const townBuildingNpcId = townBuildingInvestigationTargetNpcId(worldState, storyState);
  const townBuildingArrivalToken = townBuildingNpcId === null
    ? null
    : choice({ type: "explore" }, revision, "探索目标建筑", "explore").choiceToken;
  const projectedTownView = townView === null || townBuildingArrivalToken === null
    ? townView
    : {
        ...townView,
        interactiveBuildings: townView.interactiveBuildings.map((entry) =>
          String(entry.npcId) === townBuildingNpcId
            ? { ...entry, arrivalChoiceToken: townBuildingArrivalToken }
            : entry,
        ),
      };

  const mapLocations = worldState.locations
    .filter((location) => worldState.unlockedLocationIds.includes(location.id))
    .map((location) => ({
      name: location.name,
      current: location.id === worldState.currentLocationId,
      visited: worldState.visitedLocationIds.includes(location.id),
      scale: locationScaleOf(location),
      travelChoice: activeBattle === null && isTravelTarget(worldState, location.id)
        ? choice({ type: "move", locationId: location.id }, revision, `前往${location.name}`, "travel")
        : null,
    }));

  const locationActions: PlayerChoiceView[] = [];
  if (activeBattle === null) {
    // 探索：仅当前地点有可探索内容（未发现线索/未处理物品或敌人/未满足目标/候选事件）
    // 时显示，避免无剧情钩子地点的空转选项（方案 1）。
    if (hasExplorableContent(worldState, storyState)
      || needsWorldBoundaryPreparation(storyState)
      || endingDecisionReady) {
      const label = endingDecisionReady
        ? "面对最终抉择"
        : needsWorldBoundaryPreparation(storyState)
        ? "继续追查下一幕线索"
        : `探索${currentLocation?.name ?? "此地"}`;
      locationActions.push(choice({ type: "explore" }, revision, label, "explore"));
    }
    // 正式交谈入口只属于当前权威 talk 目标；其余在场 NPC 一律零回合闲聊展示，
    // 不再提供可提交的 ask 行动。
    if (
      currentObjective?.kind === "talk_to_npc"
      && presentNpcs.some((npc) => String(npc.id) === String(currentObjective.npcId))
    ) {
      const objectiveNpc = presentNpcs.find((npc) => String(npc.id) === String(currentObjective.npcId))!;
      locationActions.push(choice(
        { type: "talk", npcId: objectiveNpc.id, dialogueAct: "ask" },
        revision,
        `与${objectiveNpc.name}交谈`,
        "dialogue",
      ));
    }
    for (const enemy of worldState.enemies) {
      if (enemy.locationId === worldState.currentLocationId && !worldState.defeatedEnemyIds.includes(enemy.id)) {
        if (!isObjectiveEntityReleased(worldState, storyState, (objective) =>
          objective.kind === "defeat_enemy" && String(objective.enemyId) === String(enemy.id))) continue;
        locationActions.push(choice({ type: "attack", enemyId: enemy.id }, revision, `挑战${enemy.name}`, "battle"));
      }
    }
  }

  const obtainableItems = activeBattle === null
    ? (currentLocation?.availableItemIds ?? [])
      .filter((itemId) => !worldState.inventory.includes(itemId))
      .filter((itemId) => isObjectiveEntityReleased(worldState, storyState, (objective) =>
        objective.kind === "obtain_item" && String(objective.itemId) === String(itemId)))
      .map((itemId, index) => {
        const item = worldState.items.find((entry) => entry.id === itemId);
        const townBuildings = projectedTownView?.interactiveBuildings ?? [];
        const townBuilding = townBuildings.length > 0
          ? townBuildings[index % townBuildings.length]
          : undefined;
        return {
          name: item?.name ?? "未知物品",
          description: item?.description ?? "",
          ...(townBuilding === undefined ? {} : { buildingId: townBuilding.buildingId }),
          choice: choice({ type: "take_item", itemId }, revision, `拾取${item?.name ?? "物品"}`, "item"),
        };
      })
    : [];

  const readyNarrative = storyState.narrative.status === "ready"
    ? storyState.narrative
    : null;
  const persistedCurrentScene = readyNarrative?.currentScene
    ?? (storyState.narrative.status === "ready"
      ? null
      : storyState.narrative.lastPresentedScene);
  // AI mode 永不向玩家投影 fixture 场景。生产 source 失败只能进入
  // provider_failed/manual retry；历史或损坏记录中的 fixture 也不能作为
  // “临时可玩”内容接管真实游戏。
  const currentScene = storyState.narrative.mode === "ai"
    && persistedCurrentScene?.source === "fixture"
    ? null
    : persistedCurrentScene;
  const persistedDialogueResume = readyNarrative?.dialogueResume;
  const dialogueResume = storyState.narrative.mode === "ai"
    && persistedDialogueResume?.scene.source === "fixture"
    ? undefined
    : persistedDialogueResume;
  const canResumeDialogue = dialogueResume !== undefined
    && currentObjectiveRef !== null
    && currentObjective !== undefined
    && currentObjective.kind === "talk_to_npc"
    && `${currentObjectiveRef.questId}:${currentObjectiveRef.objectiveIndex}` === dialogueResume.objectiveKey
    && String(currentObjective.npcId) === String(dialogueResume.npcId)
    && String(worldState.currentLocationId) === String(dialogueResume.locationId)
    && presentNpcs.some((npc) => String(npc.id) === String(dialogueResume.npcId));
  const restoredDialogue = canResumeDialogue && dialogueResume !== undefined
    ? restoreDialogueResume(dialogueResume, revision)
    : null;
  const scene = restoredDialogue?.scene ?? currentScene;
  const registry = restoredDialogue?.choiceRegistry
    ?? (scene === null ? [] : readyNarrative?.choiceRegistry)
    ?? [];
  // 只有结构化 dialogue event 才能赋予 NPC“焦点对话”能力。
  // observe/travel 等场景也可能带 npcLine 作为旁白表演，但不能因此泄露
  // 自由输入或伪造一个没有两个批准选项的焦点对话框。
  const sceneLineNpcId = scene?.npcLine === null || scene?.npcLine === undefined
    ? null
    : String(scene.npcLine.npcId);
  // 规则层的 dialogueSession 在第二次正式回应后置 completed=true；此时
  // scene 允许只有一个 choices，它是旧 NPC 最后一段对白后的真实 handoff，
  // 不能再按普通地点行动或闲聊处理。
  const singleChoiceDialogueHandoff = scene !== null
    && scene !== undefined
    && scene.choices.length === 1
    && sceneLineNpcId !== null
    && storyState.narrative.dialogueSession?.completed === true;
  const generatedObjectiveNpcFocus = currentObjectiveNpcId !== null
    && sceneLineNpcId === currentObjectiveNpcId
    && presentNpcs.some((npc) => String(npc.id) === currentObjectiveNpcId)
    ? currentObjectiveNpcId
    : null;
  const legalChoiceMap = buildChoiceMap(worldState, storyState, revision);
  // 终幕（或一次战斗/移动后的追问）有时已没有未完成 objective，却仍由同
  // 一名在场 NPC 给出两个已批准的 TalkAction。这是该 NPC 的回答分支，不是
  // 地点层的两个普通行动；将它识别为焦点对话，避免把终局决定散落到行动栏。
  const pairedDialogueNpcId = (() => {
    if (scene === null || scene === undefined || scene.choices.length !== 2) return null;
    const actions: Extract<Action, { type: "talk" }>[] = [];
    for (const sceneChoice of scene.choices) {
      const approved = registry.find((entry) =>
        entry.choiceToken === sceneChoice.choiceToken
        && entry.sceneId === scene.sceneId
        && entry.basedOnRevision === revision,
      );
      if (
        approved === undefined
        || legalChoiceMap.get(sceneChoice.choiceToken) !== approved.action
        || approved.action.type !== "talk"
      ) return null;
      actions.push(approved.action);
    }
    const npcId = actions[0]?.npcId;
    return npcId !== undefined
      && actions.every((action) => action.npcId === npcId)
      && presentNpcs.some((npc) => npc.id === npcId)
      ? String(npcId)
      : null;
  })();
  const endingPairFocusNpcId = storyState.endingAllowed && scene?.choices.length === 2
    ? (() => {
        const actions = scene.choices.map((sceneChoice) => registry.find((entry) =>
          entry.choiceToken === sceneChoice.choiceToken && entry.sceneId === scene.sceneId,
        )?.action);
        const npcId = actions[0]?.type === "talk" ? String(actions[0].npcId) : null;
        return npcId !== null
          && actions.every((action) => action?.type === "talk" && String(action.npcId) === npcId)
          && presentNpcs.some((npc) => String(npc.id) === npcId)
          ? npcId
          : null;
      })()
    : null;
  const generatedObjectiveSceneHasInvalidChoices = generatedObjectiveNpcFocus !== null
    && scene !== null
    && scene !== undefined
    && scene.event?.kind !== "dialogue"
    && scene.choices.length === 2
    && scene.choices.some((sceneChoice) => {
      const approved = registry.find((entry) =>
        entry.choiceToken === sceneChoice.choiceToken
        && entry.sceneId === scene.sceneId
        && entry.basedOnRevision === revision,
      );
      return approved === undefined
        || approved.action.type !== "talk"
        || String(approved.action.npcId) !== generatedObjectiveNpcFocus;
    });
  const persistedFocusNpcId = singleChoiceDialogueHandoff
    ? null
    : scene?.event?.kind === "dialogue"
    ? String(scene.event.focusNpcId)
    : generatedObjectiveNpcFocus ?? pairedDialogueNpcId ?? endingPairFocusNpcId;
  const persistedFocusNpc = persistedFocusNpcId === null
    ? undefined
    : worldState.npcs.find((npc) => String(npc.id) === persistedFocusNpcId);
  const latestFocusDialogueAct = persistedFocusNpc?.memory.interactionHistory.at(-1)?.dialogueAct;
  const isEndingDialogueDecision = storyState.endingAllowed
    || storyState.evolution.status === "needs_ending_pair";
  const currentObjectiveRequiresNonDialogueAction = currentObjective !== undefined
    && currentObjective.kind !== "talk_to_npc";
  // 兼容已经写入本地存档的旧交接场景：若权威当前目标明确要求与另一名
  // 在场 NPC 交谈，旧 scene 的 focus/choices 已经过期。将旧 NPC 降为普通
  // 交谈入口，避免继续消费同一组 support/challenge token。当前目标已经
  // 进入调查/移动/取物/战斗时，即使旧场景的两个 talk token 仍然机械合法，
  // 也不能把上一轮 NPC 继续投影成焦点；只有没有活动目标的自由回访，或
  // 明确进入结局抉择，才保留同 NPC 的双选项。
  const staleDialogueFocus = persistedFocusNpcId !== null
    && (
      (!isEndingDialogueDecision
        && currentObjectiveRequiresNonDialogueAction
        // 玩家刚主动点击 NPC 打开的 ask 对话仍是一个有效的可选交谈；
        // support/challenge/freeform 刚完成后才说明旧焦点已经消费完毕。
        && latestFocusDialogueAct !== "ask")
      ||
      // 当前目标已经换成另一名 NPC：旧交接对白不能继续拦住新目标。
      (currentObjectiveNpcId !== null
        && currentObjectiveNpcId !== persistedFocusNpcId
        && presentNpcs.some((npc) => String(npc.id) === currentObjectiveNpcId))
      // 当前目标已不是交谈目标时，只保留仍有两个合法 talk choice 的终局对白；
      // 旧场景若 choice token 已过期，就必须退回地点层行动（例如战斗入口）。
      || (!isEndingDialogueDecision
        && currentObjectiveNpcId === null
        && pairedDialogueNpcId !== persistedFocusNpcId)
      // 兼容已经写入存档的旧抵达场景：它可能把 move/explore 与目标 NPC
      // 的 talk 混进同一组 choices。隐藏这组过期 token，改由下方 handoff
      // 分支即时铸造两个合法 talk runtime token，避免旧坏数据继续可提交。
      || generatedObjectiveSceneHasInvalidChoices
    );
  const handoffFocusNpc = staleDialogueFocus || persistedFocusNpcId === null
    ? currentObjectiveNpcId === null
      ? undefined
      : presentNpcs.find((npc) => String(npc.id) === currentObjectiveNpcId)
    : undefined;
  const focusNpcId = readyNarrative === null
    ? null
    : handoffFocusNpc === undefined
      ? staleDialogueFocus ? null : persistedFocusNpcId
      : String(handoffFocusNpc.id);
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
      label: formatSceneChoiceLabel(approved.action, approved.label),
      ...(sceneChoice.hint === undefined ? {} : { hint: sceneChoice.hint }),
      presentation: presentationForAction(approved.action),
    };
  };
  const projectedSceneChoices = readyNarrative === null || staleDialogueFocus
    ? []
    : scene?.choices
      .map(projectSceneChoice)
      .filter((entry): entry is PlayerChoiceView => entry !== null) ?? [];
  const endingChoiceNpcId = storyState.endingAllowed && projectedSceneChoices.length === 2
    ? (() => {
        const action = registry.find((entry) => entry.choiceToken === projectedSceneChoices[0]?.choiceToken)?.action;
        return action?.type === "talk" ? String(action.npcId) : null;
      })()
    : null;
  const isDialogueScene = focusNpcId !== null || endingChoiceNpcId !== null;
  const isSingleChoiceHandoff = singleChoiceDialogueHandoff && sceneLineNpcId !== null;
  const projectedHandoffAcknowledgement = scene?.handoffAcknowledgement?.trim() === undefined
    || scene.handoffAcknowledgement.trim() === ""
    ? null
    : { label: scene.handoffAcknowledgement };
  const dialogueChoices: NpcDialogueView["choices"] = isDialogueScene && projectedSceneChoices.length === 2
      ? [projectedSceneChoices[0]!, projectedSceneChoices[1]!]
      : [];
  const sceneDialogues = new Map((scene?.npcDialogues ?? []).map((entry) => [String(entry.npcId), entry]));
  const npcDialogues: readonly NpcDialogueView[] = presentNpcs.map((npc) => {
    const isFocus = focusNpcId === String(npc.id) || endingChoiceNpcId === String(npc.id);
    const supplied = sceneDialogues.get(String(npc.id));
    const normalizedFocusLine = scene?.npcLine !== null
      && scene?.npcLine !== undefined
      && scene.npcLine.npcId === npc.id
      && scene.npcLine.text.trim() !== ""
      ? normalizeNpcSpeech(scene.npcLine.text, npc.name)
      : null;
    const focusLine = normalizedFocusLine === "" ? null : normalizedFocusLine;
    const suppliedSpeechPages = supplied?.speechPages
      .map((page) => normalizeNpcSpeech(page, npc.name))
      .filter((page) => page !== "") ?? [];
    // 旧场景“欢迎光临”类通用问候没有剧情上下文，读取时重建
    const onlyLegacyGenericGreeting = suppliedSpeechPages.length > 0
      && suppliedSpeechPages.every((page) => page === composeDirectNpcGreeting());
    const usableSupplied = suppliedSpeechPages.length > 0 && !onlyLegacyGenericGreeting
      ? suppliedSpeechPages
      : null;
    const inferredSpeechSource = scene !== null && sceneLineNpcId === String(npc.id)
      ? scene.source
      : "fixture";
    const speechSource = supplied?.speechSource ?? inferredSpeechSource;
    // 新场景显式保存台词用途；旧存档只允许 scene.npcLine 的说话者被推断为
    // focus。非焦点 ambient 台词即使后来成为任务目标，也不能升级成正式回应。
    const speechPurpose = endingChoiceNpcId === String(npc.id)
      ? "focus"
      : supplied?.speechPurpose
      ?? (sceneLineNpcId === String(npc.id) ? "focus" : "ambient");
    const hasFormalFocusSpeech = speechPurpose === "focus"
      && (usableSupplied !== null || focusLine !== null);
    const allowOfflineSynthesis = storyState.narrative.mode === "offline";
    // 新目标 NPC 尚未拥有可消费的正式场景 registry 时，统一进入 start
    // 状态：NPC 卡点击提交一次 ask，由 provider 生成真正的首句和两项批准
    // 回应。环境闲聊、deterministic fallback 和自由输入都不能伪装 ready。
    const isAuthoritativeTalkTarget = isFocus
      && currentObjectiveNpcId === String(npc.id);
    const requiresFormalDialogueStart = isFocus && (
      (handoffFocusNpc !== undefined && String(handoffFocusNpc.id) === String(npc.id))
      || (isAuthoritativeTalkTarget && !hasFormalFocusSpeech && !allowOfflineSynthesis)
    );
    const interactionCount = npc.memory.interactionHistory.length;
    const offlineIdleLine = allowOfflineSynthesis
      ? composeIdleNpcLine({
          currentObjectiveLabel: currentObjectiveRef?.label ?? null,
          hasInteractionHistory: interactionCount > 0,
          variantIndex: storyState.turnNumber + storyState.currentAct + interactionCount,
        })
      : null;
    const hasDisplayableSpeech = usableSupplied !== null
      || focusLine !== null
      || allowOfflineSynthesis;
    const speechPages = requiresFormalDialogueStart && !hasFormalFocusSpeech
      ? []
      : usableSupplied !== null
      ? decorateNarrativePages(usableSupplied, speechSource)
      : focusLine !== null
      ? decorateNarrativePages(
          paginateSpeechText(
            focusLine,
            NPC_SCENE_PAGE_CHAR_BUDGET,
          ),
          speechSource,
        )
      : allowOfflineSynthesis
      ? decorateNarrativePages(
          paginateSpeechText(
            isFocus
              ? composeDeterministicNpcLine(npc.name, npc.role)
              : offlineIdleLine ?? "",
            NPC_SCENE_PAGE_CHAR_BUDGET,
          ),
          speechSource,
        )
      : [];
    const startChoice = requiresFormalDialogueStart
      ? choice(
          { type: "talk", npcId: npc.id, dialogueAct: "ask" },
          revision,
          `与${npc.name}交谈`,
          "dialogue",
        )
      : undefined;
    const formalDialogueReady = isFocus
      && (hasFormalFocusSpeech || allowOfflineSynthesis)
      && hasDisplayableSpeech
      && !requiresFormalDialogueStart;
    return {
      npcId: String(npc.id),
      name: npc.name,
      role: npc.role,
      speechPages,
      // 非焦点 NPC 是零回合闲聊：不提供任何可提交选项；正式对话只能经
      // 当前权威 talk 目标入口（NPC 卡片/交接双选项）开启。
      choices: formalDialogueReady ? dialogueChoices : [],
      ...(projectedHandoffAcknowledgement !== null && String(npc.id) === sceneLineNpcId
        ? { handoffAcknowledgement: projectedHandoffAcknowledgement }
        : {}),
      ...(startChoice === undefined ? {} : { startChoice }),
      freeInputEnabled: formalDialogueReady,
      giveChoices: formalDialogueReady
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
    };
  });

  const battle = activeBattle === null ? null : projectCombatView(worldState, activeBattle, revision);
  const sceneNpc = scene?.npcLine === null || scene?.npcLine === undefined
    ? undefined
    : presentNpcs.find((npc) => String(npc.id) === String(scene.npcLine?.npcId));
  const projectedNpcLine = scene?.npcLine === null || scene?.npcLine === undefined
    ? null
    : {
        text: decorateNarrativeText(
          normalizeNpcSpeech(scene.npcLine.text, sceneNpc?.name),
          scene.source,
        ),
        emotion: scene.npcLine.emotion,
        ...(sceneNpc === undefined ? {} : { speaker: sceneNpc.name }),
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
        npcId: String(npc.id),
        name: npc.name,
        role: npc.role,
        // talkChoice 只在“该 NPC 就是当前权威 talk 目标”时下发
        talkChoice: currentObjectiveNpcId === String(npc.id)
          ? choice(
              { type: "talk", npcId: npc.id, dialogueAct: "ask" },
              revision,
              `与${npc.name}交谈`,
              "dialogue",
            )
          : null,
      })),
      town: projectedTownView,
    },
    obtainableItems,
    inventory: worldState.inventory.map((itemId) => {
      const item = worldState.items.find((entry) => entry.id === itemId);
      return {
        name: item?.name ?? "未知物品",
        description: item?.description ?? "",
        ...resolveItemPresentation(item ?? { kind: "unknown" }),
      };
    }),
    story: {
      currentAct: storyState.currentAct,
      targetActs: storyState.targetActs,
      tension: storyState.tension,
      pacingNeed: storyState.nextPacingNeed,
      storyProgress: storyState.storyProgress,
      currentObjectiveLabel: currentObjectiveRef?.label ?? (endingDecisionReady ? "选择结局方向" : null),
      currentObjectiveChoiceToken: currentObjectiveToken,
      currentObjectiveChoiceTokens: currentObjectiveTokens,
    },
    narrative: {
      mode: storyState.narrative.mode,
      hasScene: scene !== null,
      ...(scene === null ? {} : {
        eventKind: scene.event?.kind,
        narration: decorateNarrativeText(scene.narration, scene.source),
      }),
      choices: isDialogueScene || isSingleChoiceHandoff ? [] : projectedSceneChoices,
      npcLine: projectedNpcLine,
      npcDialogues,
    },
    narrativeGeneration: storyState.narrative.status === "provider_failed"
      ? { status: "failed", failureKind: storyState.narrative.failure.kind, jobKey: String(storyState.narrative.job.jobId) }
      : storyState.narrative.status === "provider_pending"
        ? { status: "pending", jobKey: String(storyState.narrative.job.jobId) }
        : { status: "idle" },
    battle,
    quests: worldState.quests.map((quest) => ({
      name: quest.name,
      description: quest.description,
      kind: quest.kind,
      status: quest.status,
      objectives: projectQuestObjectives(worldState, storyState, String(quest.id), quest.objectives),
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
