import type { Action } from "@/game/domain/action";
import type { EvolutionNeed } from "@/game/domain/worldDelta";
import type { QuestObjective, WorldState } from "@/game/domain/worldState";
import { projectEntityStore } from "@/game/domain/entity";
import type { WorldEvolutionSourceContext } from "@/game/application/worldEvolutionSource";
import { currentObjectiveOf } from "@/game/gameplay/rpg/narrativeContext";
import { compileNarrativeContext } from "./compileNarrativeContext";
import type { NarrativeContextBlock, NarrativePromptCompilation } from "./contextBlock";
import { createNarrativePromptCompilation } from "./renderNarrativeContext";

export const WORLD_CONTEXT_MAX_ESTIMATED_TOKENS = 8_000;

type WorldBlockInput = Omit<NarrativeContextBlock, "id" | "title" | "source"> & Readonly<{
  id: string;
  title: string;
  sourceKind: string;
  sourceRefs?: readonly string[];
}>;

type RecentBeat = Readonly<{ turn: number; kind: string; summary: string }>;

function worldBlock(input: WorldBlockInput): NarrativeContextBlock {
  return {
    id: input.id,
    title: input.title,
    source: { kind: input.sourceKind, refs: input.sourceRefs ?? [] },
    slot: input.slot,
    content: input.content,
    authority: input.authority,
    retention: input.retention,
    priority: input.priority,
  };
}

function isRecentBeat(value: unknown): value is RecentBeat {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Number.isFinite(record.turn)
    && typeof record.kind === "string"
    && typeof record.summary === "string";
}

function genreRule(gameType: string): string {
  return gameType === "wuxia"
    ? "题材锁定为武侠：只能使用江湖、门派、镖局、官府、山川、兵器、线索和武学语汇；不得出现魔法、巫师、精灵、骑士、幽灵/灵魂、祭坛、法阵、圣光、异界等奇幻或超自然实体。"
    : `题材锁定为${gameType}，不得跨题材改写世界规则。`;
}

function locationPlacementRule(currentLocation: WorldState["locations"][number] | undefined): string {
  if (currentLocation?.scale === "town") {
    const slots = currentLocation.town?.slots ?? [];
    const freeSlotCount = slots.filter((slot) => slot.boundNpcId === null).length;
    const capacity = `${freeSlotCount}/${slots.length}`;
    if (freeSlotCount === 0) {
      return `当前地点是城镇容器，但剧情建筑槽位已满（可用槽位=${capacity}）：本次禁止使用 placement=town_building。需要独立旅行的地点必须使用 placement=world；如果同时创建 newNpc 且该 NPC 属于新地点，newNpc.locationRef 必须是 {\"kind\":\"new_location\"}，不能写 current 城镇或任何 existing 地点。`;
    }
    return `当前地点是城镇容器：城镇内部的茶馆、酒楼、客栈、铺面、宅院或后巷必须使用 placement=town_building；当前剧情建筑槽位可用=${capacity}。该建筑不会成为世界地图节点，且同次新 NPC 的 locationRef 必须为 {\"kind\":\"new_location\"}。需要独立旅行的地点才使用 placement=world。`;
  }
  return "当前地点不是城镇容器：新地点通常使用 placement=world；town_building 只可挂在当前城镇容器。";
}

function describeSafeAction(action: Action | undefined, disclosedPublicFactIds: ReadonlySet<string>): string {
  if (action === undefined) return "无";
  switch (action.type) {
    case "talk": return `type=talk;npcId=${action.npcId};dialogueAct=${action.dialogueAct}`;
    case "move": return `type=move;locationId=${action.locationId}`;
    case "investigate": return disclosedPublicFactIds.has(String(action.factId))
      ? `type=investigate;factId=${action.factId};approachId=${action.approachId ?? "无"}`
      : `type=investigate;approachId=${action.approachId ?? "无"}`;
    case "take_item": return `type=take_item;itemId=${action.itemId}`;
    case "give_item": return `type=give_item;itemId=${action.itemId};npcId=${action.npcId}`;
    case "attack": return `type=attack;enemyId=${action.enemyId}`;
    case "battle_action": return `type=battle_action;action=${action.action}`;
    case "explore": return "type=explore";
    case "ack_prologue": return "type=ack_prologue";
    // rawText may contain player-private input; intent is also parser output that is not needed here.
    case "freeform": return "type=freeform";
  }
}

function objectiveEntityId(objective: QuestObjective | undefined): string | undefined {
  if (objective === undefined) return undefined;
  switch (objective.kind) {
    case "visit_location": return String(objective.locationId);
    case "talk_to_npc": return String(objective.npcId);
    case "obtain_item": return String(objective.itemId);
    case "discover_fact": return String(objective.factId);
    case "defeat_enemy": return String(objective.enemyId);
  }
}

function outputContract(need: EvolutionNeed): string {
  const commonFields = `可用增量字段（只在需要时出现）：\n- newLocation={"name":"2-40字名称","description":"非空且≤200字","scale":"scene或town","placement":"world或town_building","connectFromLocationId":"已有地点ID"}\n- newNpc={"name":"2-40字名称","role":"非空且≤200字","description":"非空且≤200字","locationRef":{"kind":"existing","id":"已有地点ID"}或{"kind":"new_location"},"anchors":{"selfConcept":"非空且≤200字","values":["1-4条非空价值"],"speechStyle":"非空且≤200字","capabilityBoundaries":["1-4条非空能力边界"],"taboos":["0-4条非空禁区"]},"goals":[{"horizon":"short或long","description":"非空且≤200字","priority":1到5,"reason":"非空且≤200字"}]}；anchors 五个字段都必需，goals 至少 1 条且最多 4 条；goalId/status 由服务端生成，禁止输出。\n- newItem={"name":"2-40字名称","description":"非空且≤200字","locationRef":"current或new_location"}\n- newEnemy={"name":"2-40字名称","tier":"normal或boss","locationRef":"current或new_location"}\n- newFact={"text":"非空且≤200字","visibility":"public或npc_private","investigationLabel":"可选，2-40字","investigationApproaches":[{"approachId":"非空ID","label":"非空提示","hint":"可选非空提示","evidenceQuality":"clean或noisy","tensionDelta":-5..20}]}；investigationApproaches 若出现，必须且只能有 2-3 条，tensionDelta=-5..20；label/hint 可以引用事实中的地点、人物或线索关键词，但不得完整复制 newFact.text。`;
  const outer = "只输出 JSON，不能解释或 Markdown。外层必须是 {\"proposal\":{...}}；proposal 必须有 beatSummary（非空且≤200字）。所有未使用字段必须完全省略，绝不写 null。newNpc 必须包含 {\"relationshipSeeds\":[{\"targetNpcId\":\"既有 active NPC ID\",\"stance\":\"ally|protective_of|indebted_to|rival|wary\",\"reason\":\"...\"}]}；relationshipSeeds 必须出现，无关系时必须输出 []；每项只能包含 targetNpcId、stance、reason，其中 targetNpcId 只能引用实体规则闭包中的既有 active NPC，reason 必须非空且≤200字；不得提交 affinity、stage、evidence 或 actionId。";

  switch (need.kind) {
    case "next_act":
      return `${outer}\n${commonFields}\n本次是下一幕需求：必须输出 nextMainQuest={"name":"2-40字名称","description":"非空且≤200字","objectiveText":"非空且≤200字"}，并且必须输出一个 placement="world" 的 newLocation，connectFromLocationId 必须等于当前地点 ID；这条任务必须把玩家带到该新地点，不能直接叙述中心冲突已解决或写出结局。newNpc/newItem/newEnemy/newFact 均为可选，只有对应剩余容量大于 0 才能输出。禁止输出 endingPair，endingPair 字段必须完全省略。`;
    case "ending_pair":
      return `${outer}\n${commonFields}\n本次是终幕结局对需求：必须输出 endingPair=[{"name":"2-40字名称","description":"非空且≤200字","themeKey":"trust"},{"name":"2-40字名称","description":"非空且≤200字","themeKey":"doubt"}]；必须恰好一条 trust 和一条 doubt，不能提交 requirements。禁止输出 nextMainQuest，nextMainQuest 字段必须完全省略。`;
    case "pacing":
      return `${outer}\n${commonFields}\n本次是节奏补足需求：只补充一个必要的新实体或事实。nextMainQuest 和 endingPair 字段必须完全省略。`;
    case "none":
      return `${outer}\n当前没有世界演化需求；不得产生 proposal。`;
  }
}

function contentRepairInstruction(
  repair: WorldEvolutionSourceContext["contentRepair"],
): string {
  if (repair === undefined) return "contentRepair=无。";
  const reasonText = repair.reason === "invalid_json"
    ? "非法 JSON"
    : repair.reason === "invalid_schema"
      ? "非法 schema"
      : repair.reason === "invalid_reference"
        ? "引用了不存在的实体"
        : repair.approvalCode === undefined
          ? "审批拒绝"
          : `审批拒绝（${repair.approvalCode}）`;
  const reasonCode = repair.reason === "approval_rejected" && repair.approvalCode !== undefined
    ? `approval_rejected:${repair.approvalCode}`
    : repair.reason;
  const repairDirective = repair.approvalCode === "town_capacity"
    ? "当前城镇建筑槽位已满：必须把新地点改为 placement=world；若同时有 newNpc，必须把其 locationRef 改为 {\"kind\":\"new_location\"}，不能继续引用当前城镇。"
    : repair.approvalCode === "unreachable_objective"
      ? "新地点主线不可达：next_act 的 world 新地点必须把 connectFromLocationId 写成当前地点 ID；若同时有 newNpc、newItem 或 newEnemy 且它们进入下一幕主线，必须把对应 locationRef 写成 {\"kind\":\"new_location\"}，以保证先抵达新地点再处理目标。"
      : "";
  return `上一轮的响应需要一次内容修复（content repair）：原因=${reasonText}（${reasonCode}）。${repairDirective}只修复该问题并重发完整提案；保留当前世界事实边界，严禁通过省略字段绕过 placement、locationRef、已有地点名、任务目标可达性等契约。`;
}

function detailPriority(input: {
  id: string;
  highPriorityIds: ReadonlySet<string>;
  nearbyIds: ReadonlySet<string>;
}): 700 | 500 | 300 {
  if (input.highPriorityIds.has(input.id)) return 700;
  return input.nearbyIds.has(input.id) ? 500 : 300;
}

export function buildWorldNarrativeContextBlocks(
  context: WorldEvolutionSourceContext,
): readonly NarrativeContextBlock[] {
  const { storyState: story } = context;
  const projected = projectEntityStore(context.worldState.entityStore);
  const world = {
    ...context.worldState,
    ...projected,
  };
  const setup = world.generation.setup;
  const currentLocation = world.locations.find((location) => location.id === world.currentLocationId);
  const currentObjective = currentObjectiveOf(world, story);
  const activeQuest = currentObjective === null
    ? world.quests.find((quest) => quest.status === "active" && quest.kind === "main")
      ?? world.quests.find((quest) => quest.status === "active")
    : world.quests.find((quest) => String(quest.id) === String(currentObjective.questId));
  const currentQuestObjective = currentObjective === null || activeQuest === undefined
    ? undefined
    : activeQuest.objectives[currentObjective.objectiveIndex];
  const targetEntityId = objectiveEntityId(currentQuestObjective);
  const hiddenFactIds = new Set(world.npcs.flatMap((npc) => npc.memory.hiddenFactIds.map(String)));
  const publicFacts = world.worldFacts.filter((fact) => fact.discovered && !hiddenFactIds.has(String(fact.factId)));
  const disclosedPublicFactIds = new Set(publicFacts.map((fact) => String(fact.factId)));
  const privateFactTexts = world.worldFacts
    .filter((fact) => hiddenFactIds.has(String(fact.factId)))
    .map((fact) => fact.text)
    .filter((text) => text.trim() !== "");
  const privateInteractionTexts = world.npcs.flatMap((npc) => npc.memory.interactionHistory.flatMap((interaction) => [
    interaction.topicSummary,
    interaction.summary,
  ])).filter((text) => text.trim() !== "");
  const privateRecentBeatMarkers = [...hiddenFactIds, ...privateFactTexts, ...privateInteractionTexts];
  const recentBeats = story.recentBeats
    .filter(isRecentBeat)
    .filter((beat) => !privateRecentBeatMarkers.some((marker) => beat.summary.includes(marker)))
    .slice(-5);
  const neighboringLocationIds = new Set(currentLocation?.connectedLocationIds.map(String) ?? []);
  const nearbyLocationIds = new Set([
    ...world.unlockedLocationIds.map(String),
    ...neighboringLocationIds,
    ...(currentLocation === undefined ? [] : [String(currentLocation.id)]),
  ]);
  const highPriorityIds = new Set([
    ...(currentLocation === undefined ? [] : [String(currentLocation.id)]),
    ...(activeQuest === undefined ? [] : [String(activeQuest.id)]),
    ...(targetEntityId === undefined ? [] : [targetEntityId]),
  ]);
  const itemLocationIds = new Map<string, string[]>();
  for (const location of world.locations) {
    for (const itemId of location.availableItemIds) {
      const locations = itemLocationIds.get(String(itemId)) ?? [];
      locations.push(String(location.id));
      itemLocationIds.set(String(itemId), locations);
    }
  }
  const inventoryIds = new Set(world.inventory.map(String));
  const safeCurrentObjectiveLabel = currentQuestObjective?.kind === "discover_fact"
    && (hiddenFactIds.has(String(currentQuestObjective.factId))
      || !world.worldFacts.some((fact) => String(fact.factId) === String(currentQuestObjective.factId) && fact.discovered))
    ? "调查现场线索"
    : currentObjective?.label;
  const activeQuestSummary = activeQuest === undefined
    ? "无活动任务。"
    : `任务=${activeQuest.name}；status=${activeQuest.status}；当前目标=${safeCurrentObjectiveLabel ?? "无"}。`;

  const blocks: NarrativeContextBlock[] = [
    worldBlock({
      id: "world:rules", slot: "system_rules", title: "世界演化规则", sourceKind: "world_evolution_source_context", sourceRefs: [],
      authority: "rule", retention: "mandatory", priority: 1000,
      content: `你只提出一次可审批的世界增量，不得改写、删除或否认当前已批准的世界、任务、事实或结局事实；不得引用实体索引之外的既有 ID，不得复用已有名称。新地点名称不得与现有地点名称重复。如果 newLocation.placement=world 且 newNpc 同时存在，newNpc.locationRef 必须为 {"kind":"new_location"}，除非本次任务明确不把该 NPC 作为新地点目标。新任务的目标顺序必须在玩家可达的地点/实体上成立。${genreRule(world.generation.gameType)}`,
    }),
    worldBlock({
      id: "world:canon", slot: "world_canon", title: "世界设定", sourceKind: "game_setup", sourceRefs: [],
      authority: "lore", retention: "optional", priority: 250,
      content: `游戏类型=${world.generation.gameType}；世界背景=${setup?.worldPremise ?? "沿用已批准世界"}；故事开端=${setup?.storyOpening ?? "沿用当前主线"}。`,
    }),
    worldBlock({
      id: "world:story-contract", slot: "story_contract", title: "故事契约", sourceKind: "story_contract", sourceRefs: [],
      authority: "plan", retention: "mandatory", priority: 850,
      content: `中心冲突=${story.contract.centralConflict}；结局方向=${story.contract.endingDirections.map((direction) => `${direction.key}=${direction.theme}`).join("；") || "无"}。实际幕数只以当前剧情状态 targetActs 为准。`,
    }),
    worldBlock({
      id: "world:current-state", slot: "current_state", title: "当前剧情状态", sourceKind: "world_evolution_source_context", sourceRefs: activeQuest === undefined ? [] : [String(activeQuest.id)],
      authority: "state", retention: "mandatory", priority: 900,
      content: `currentAct=${story.currentAct}；targetActs=${story.targetActs}；storyProgress=${story.storyProgress}；tension=${story.tension}；nextPacingNeed=${story.nextPacingNeed}；budget=locations:${story.budget.locations.opening}+${story.budget.locations.expanded}/${story.budget.locations.max},npcs:${story.budget.npcs.opening}+${story.budget.npcs.expanded}/${story.budget.npcs.max},quests:${story.budget.quests.opening}+${story.budget.quests.expanded}/${story.budget.quests.max},events:${story.budget.events.opening}+${story.budget.events.expanded}/${story.budget.events.max}；${activeQuestSummary}unresolvedThreads=${story.unresolvedThreads.join(",") || "无"}。`,
    }),
    worldBlock({
      id: "world:current-location", slot: "current_location", title: "当前地点与空间规则", sourceKind: "world_state", sourceRefs: currentLocation === undefined ? [] : [String(currentLocation.id)],
      authority: "state", retention: "mandatory", priority: 900,
      content: currentLocation === undefined
        ? "当前地点缺失；不得引用或创建无法挂接的 existing 地点。"
        : `当前地点=${currentLocation.id}=${currentLocation.name}；scale=${currentLocation.scale ?? "scene"}；${locationPlacementRule(currentLocation)}`,
    }),
    worldBlock({
      id: "world:entity-index", slot: "current_state", title: "已批准实体索引", sourceKind: "world_state", sourceRefs: [
        ...world.locations.map((entry) => String(entry.id)),
        ...world.npcs.map((entry) => String(entry.id)),
        ...world.items.map((entry) => String(entry.id)),
        ...world.enemies.map((entry) => String(entry.id)),
        ...world.quests.map((entry) => String(entry.id)),
        ...publicFacts.map((entry) => String(entry.factId)),
      ],
      authority: "state", retention: "mandatory", priority: 800,
      content: `Locations=${world.locations.map((entry) => `${entry.id}=${entry.name}`).join("；") || "无"}\nNPCs=${world.npcs.map((entry) => `${entry.id}=${entry.name}`).join("；") || "无"}\nItems=${world.items.map((entry) => `${entry.id}=${entry.name}`).join("；") || "无"}\nEnemies=${world.enemies.map((entry) => `${entry.id}=${entry.name}`).join("；") || "无"}\nQuests=${world.quests.map((entry) => `${entry.id}=${entry.name}`).join("；") || "无"}\nDiscovered public fact IDs=${publicFacts.map((entry) => String(entry.factId)).join("；") || "无"}\n只可引用这个索引中的既有 ID；名称不得与索引中的任何名称重复。`,
    }),
    worldBlock({
      id: "world:evolution-need", slot: "current_resolution", title: "本次演化需求", sourceKind: "world_evolution_source_context", sourceRefs: [],
      authority: "state", retention: "mandatory", priority: 950,
      content: `need=${JSON.stringify(context.need)}；reason=${context.reason}；action=${describeSafeAction(context.action, disclosedPublicFactIds)}；${contentRepairInstruction(context.contentRepair)}`,
    }),
    worldBlock({
      id: "world:output-contract", slot: "output_contract", title: "WorldDelta 输出契约", sourceKind: "world_delta_parser", sourceRefs: [],
      authority: "rule", retention: "mandatory", priority: 1000,
      content: outputContract(context.need),
    }),
  ];

  for (const location of world.locations) {
    const priority = detailPriority({ id: String(location.id), highPriorityIds, nearbyIds: nearbyLocationIds });
    blocks.push(worldBlock({
      id: `world:location:${location.id}`, slot: "current_location", title: `地点 ${location.name}`, sourceKind: "world_state", sourceRefs: [String(location.id)],
      authority: "state", retention: "optional", priority,
      content: `id=${location.id}；name=${location.name}；description=${location.description}；kind=${location.kind}；scale=${location.scale ?? "scene"}；connectedLocationIds=[${location.connectedLocationIds.join(",")}]。`,
    }));
  }

  for (const npc of world.npcs) {
    const priority = detailPriority({
      id: String(npc.id), highPriorityIds,
      nearbyIds: new Set(world.npcs.filter((entry) => nearbyLocationIds.has(String(entry.locationId))).map((entry) => String(entry.id))),
    });
    blocks.push(worldBlock({
      id: `world:npc:${npc.id}`, slot: "current_state", title: `角色 ${npc.name}`, sourceKind: "world_state", sourceRefs: [String(npc.id), String(npc.locationId)],
      authority: "state", retention: "optional", priority,
      content: `id=${npc.id}；name=${npc.name}；role=${npc.role}；locationId=${npc.locationId}；goals=${npc.memory.goals.join("、") || "无"}。`,
    }));
  }

  for (const item of world.items) {
    const locations = itemLocationIds.get(String(item.id)) ?? [];
    const nearby = new Set([
      ...world.items.filter((entry) => inventoryIds.has(String(entry.id)) || (itemLocationIds.get(String(entry.id)) ?? []).some((id) => nearbyLocationIds.has(id))).map((entry) => String(entry.id)),
      ...inventoryIds,
    ]);
    const priority = detailPriority({ id: String(item.id), highPriorityIds, nearbyIds: nearby });
    blocks.push(worldBlock({
      id: `world:item:${item.id}`, slot: "current_state", title: `物品 ${item.name}`, sourceKind: "world_state", sourceRefs: [String(item.id), ...locations],
      authority: "state", retention: "optional", priority,
      content: `id=${item.id}；name=${item.name}；description=${item.description}；locations=[${locations.join(",") || "无"}]；inInventory=${inventoryIds.has(String(item.id))}。`,
    }));
  }

  for (const enemy of world.enemies) {
    const nearby = new Set(world.enemies.filter((entry) => nearbyLocationIds.has(String(entry.locationId))).map((entry) => String(entry.id)));
    const priority = detailPriority({ id: String(enemy.id), highPriorityIds, nearbyIds: nearby });
    blocks.push(worldBlock({
      id: `world:enemy:${enemy.id}`, slot: "current_state", title: `敌人 ${enemy.name}`, sourceKind: "world_state", sourceRefs: [String(enemy.id), String(enemy.locationId)],
      authority: "state", retention: "optional", priority,
      content: `id=${enemy.id}；name=${enemy.name}；tier=${enemy.tier}；locationId=${enemy.locationId}；defeated=${world.defeatedEnemyIds.some((id) => String(id) === String(enemy.id))}。`,
    }));
  }

  for (const quest of world.quests) {
    const priority = detailPriority({ id: String(quest.id), highPriorityIds, nearbyIds: new Set() });
    const objective = currentObjective !== null && String(currentObjective.questId) === String(quest.id)
      ? { ...currentObjective, label: safeCurrentObjectiveLabel ?? "调查现场线索" }
      : undefined;
    blocks.push(worldBlock({
      id: `world:quest:${quest.id}`, slot: "current_state", title: `任务 ${quest.name}`, sourceKind: "world_state", sourceRefs: [String(quest.id)],
      authority: "state", retention: "optional", priority,
      content: `id=${quest.id}；name=${quest.name}；description=${quest.description}；kind=${quest.kind}；status=${quest.status}；currentObjective=${objective === undefined ? "无" : `${objective.objectiveIndex}:${objective.label}`}。`,
    }));
  }

  for (const fact of publicFacts) {
    const priority = detailPriority({
      id: String(fact.factId), highPriorityIds,
      nearbyIds: new Set(publicFacts.filter((entry) => entry.locationId !== undefined && nearbyLocationIds.has(String(entry.locationId))).map((entry) => String(entry.factId))),
    });
    blocks.push(worldBlock({
      id: `world:public-fact:${fact.factId}`, slot: "current_state", title: `公开事实 ${fact.factId}`, sourceKind: "world_state", sourceRefs: [String(fact.factId)],
      authority: "state", retention: "optional", priority,
      content: `id=${fact.factId}；text=${fact.text}；locationId=${fact.locationId ?? "无"}。`,
    }));
  }

  if (recentBeats.length > 0) {
    blocks.push(worldBlock({
      id: "world:relevant-events", slot: "relevant_events", title: "相关近期事件", sourceKind: "recent_beats", sourceRefs: recentBeats.map((beat) => String(beat.turn)),
      authority: "event", retention: "optional", priority: 650,
      content: recentBeats.map((beat) => `turn=${beat.turn}；kind=${beat.kind}；summary=${beat.summary}`).join("\n"),
    }));
  }

  return blocks;
}

export function compileWorldNarrativeContext(
  context: WorldEvolutionSourceContext,
): NarrativePromptCompilation {
  return createNarrativePromptCompilation(compileNarrativeContext({
    maxEstimatedTokens: WORLD_CONTEXT_MAX_ESTIMATED_TOKENS,
    blocks: buildWorldNarrativeContextBlocks(context),
  }));
}
