import type { Action } from "@/game/domain/action";
import { ATMOSPHERE_BEAT_ID } from "@/game/domain/narrativeBeat";
import type { NarrativeSceneState } from "@/game/domain/narrative";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import { relationshipTierOf } from "@/game/domain/relationship";
import type { StoryState } from "@/game/domain/storyState";
import type { WorldState } from "@/game/domain/worldState";
import { projectEntityStore } from "@/game/domain/entity";
import { buildStylePolicy } from "@/game/application/stylePolicy";
import { buildEntityContextProjection, type EntityContextProjection } from "@/game/application/entityContextProjection";
import {
  buildNarrativeBundleDescriptors,
} from "@/game/gameplay/rpg/narrativeBundle";
import {
  createNpcResponsePolicy,
  selectAllowedDisclosureFactIds,
} from "@/game/gameplay/rpg/narrativeContext";
import type {
  NarrativeBundleRepair,
} from "@/game/application/narrativeBundleSource";
import { compileNarrativeContext } from "./compileNarrativeContext";
import {
  type NarrativeContextBlock,
  type NarrativePromptCompilation,
} from "./contextBlock";
import { createNarrativePromptCompilation } from "./renderNarrativeContext";

export const NARRATIVE_BUNDLE_CONTEXT_MAX_ESTIMATED_TOKENS = 8_000;

type DecisionNarrativeContextInput = Readonly<{
  worldState: WorldState;
  storyState: StoryState;
  job: PendingNarrativeJob;
  contentRepair?: NarrativeBundleRepair;
}>;

function block(input: NarrativeContextBlock): NarrativeContextBlock {
  return input;
}

function list(values: readonly string[]): string {
  return values.length === 0 ? "（无）" : values.join("、");
}

function occupiedNamesSection(context: EntityContextProjection): string {
  return [
    `- 地点：${list(context.occupiedNames.location)}`,
    `- NPC：${list(context.occupiedNames.npc)}`,
    `- 物品：${list(context.occupiedNames.item)}`,
    `- 敌人：${list(context.occupiedNames.enemy)}`,
    `- 任务：${list(context.occupiedNames.quest)}`,
  ].join("\n");
}

function itemStateSection(context: EntityContextProjection): string {
  const items = [...context.mandatory, ...context.optional].filter((entity) => entity.kind === "item");
  return items.length === 0
    ? "（当前闭包无相关物品）"
    : items.map((item) => `- ${item.name}（${item.id}）：${item.summary}`).join("\n");
}

function repairInstruction(repair: NarrativeBundleRepair): string {
  const rejection = [
    repair.rejectionCode === undefined ? "" : `拒绝码 ${repair.rejectionCode}`,
    repair.detail === undefined ? "" : `细分原因 ${repair.detail}`,
  ].filter((part) => part !== "").join("，");
  const duplicateEntries = repair.detail?.startsWith("duplicate_name:")
    ? repair.detail.slice("duplicate_name:".length).split("|")
      .map((entry) => entry.match(/^(npc|location|item|enemy|quest):(.+)$/u))
      .filter((entry): entry is RegExpMatchArray => entry !== null)
    : [];
  const duplicateInstruction = duplicateEntries.map((entry) =>
    `- 上一轮新${entry[1]}名称“${entry[2]}”已与世界中现有实体重复；本轮必须另起一个未占用名称，不能沿用或仅加“新”“另一个”等前缀。`,
  ).join("\n");
  return `上一轮提案已被服务端拒绝。\n${rejection === "" ? `失败类型 ${repair.reason}。` : `${rejection}。`}
本轮只需修正被拒绝的那一项，其余中文叙事文本可以沿用你自己的写法。硬性要求：
- continuationScenes 必须与服务端投影步骤一一对应：不得新增投影之外的步骤，也不得漏掉投影中的步骤。
- 终点步骤（terminal.target.stepKey 指向的那一步）必须给出该步骤列出的全部 candidateId 选项，每个选项都要有中文 label；其余步骤 choices 必须为空。
- 新地点/NPC/物品/敌人/任务的名称不得与“已占用实体名称”中的任何一项重复。
${duplicateInstruction}`;
}

function recentScene(storyState: StoryState): NarrativeSceneState | null {
  const narrative = storyState.narrative;
  if (narrative.status === "ready") return narrative.currentScene;
  return narrative.lastPresentedScene;
}

function clipText(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}……`;
}

function isRecentBeat(value: unknown): value is { readonly turn: number; readonly kind: string; readonly summary: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const beat = value as Record<string, unknown>;
  return Number.isFinite(beat.turn) && typeof beat.kind === "string" && typeof beat.summary === "string";
}

function focusNpcContent(worldState: WorldState, job: PendingNarrativeJob): string {
  const focusNpc = job.focusNpcId === undefined
    ? undefined
    : worldState.npcs.find((npc) => String(npc.id) === String(job.focusNpcId));
  if (focusNpc === undefined) return "本回合没有焦点 NPC；currentScene.npcLine 仅在权威图明确要求时出现。";

  const tier = relationshipTierOf(focusNpc.memory.relationship);
  const allowedDisclosureFactIds = selectAllowedDisclosureFactIds({
    tier,
    knownFactIds: focusNpc.memory.knownFactIds,
    hiddenFactIds: focusNpc.memory.hiddenFactIds,
  });
  const policy = createNpcResponsePolicy({
    tier,
    allowedDisclosureFactIds,
    privateKnowledgeIds: focusNpc.memory.hiddenFactIds,
  });
  const factById = new Map(worldState.worldFacts.map((fact) => [String(fact.factId), fact]));
  const speakableFacts = policy.allowedDisclosureFactIds
    .map((factId) => factById.get(String(factId)))
    .filter((fact): fact is NonNullable<typeof fact> => fact !== undefined)
    .map((fact) => `${fact.factId}=${fact.text}`);
  const interactions = focusNpc.memory.interactionHistory.slice(-5).map((interaction) =>
    `${interaction.actionId}：dialogueAct=${interaction.dialogueAct}；topic=${interaction.topicSummary}；outcome=${interaction.outcome}；summary=${interaction.summary}`,
  );
  const thisTurn = [...focusNpc.memory.interactionHistory]
    .reverse()
    .find((interaction) => interaction.actionId === job.actionId);

  return [
    `本回合对话焦点 NPC：${focusNpc.name}（${focusNpc.id}，${focusNpc.role}）`,
    `公开档案=${focusNpc.description}`,
    `关系档位=${policy.tier}；回应语气=${policy.toneInstruction}；主动性=${policy.initiative}`,
    `当前情绪=${focusNpc.memory.emotion}；目标=${list(focusNpc.memory.goals)}`,
    `本轮关系信号=${thisTurn === undefined ? "neutral" : `${thisTurn.outcome}（delta=${thisTurn.relationshipDelta}）`}`,
    `允许披露事实=${list(speakableFacts)}`,
    `最近五条结构化交互：\n${interactions.length === 0 ? "（无）" : interactions.map((entry) => `- ${entry}`).join("\n")}`,
    "私密事实正文与未授权知识不在本上下文中；不得自行补全。",
  ].join("\n");
}

function expectedBundleProjection(worldState: WorldState, storyState: StoryState, job: PendingNarrativeJob) {
  const descriptorGraph = buildNarrativeBundleDescriptors({
    worldState,
    storyState,
    transition: job.objectiveTransition,
  });
  const nextActProjection = storyState.evolution.status === "needs_next_act"
    ? {
        locationId: `loc_dyn_${storyState.evolution.nextLocationOrdinal}`,
        npcId: `npc_dyn_${storyState.evolution.nextNpcOrdinal}`,
      }
    : null;
  const expectedChoices = nextActProjection !== null || descriptorGraph.currentChoiceCandidates.length === 0
    ? "当前场景不允许 choices；终点步骤的 choices 必须使用下方对应候选。"
    : descriptorGraph.currentChoiceCandidates.map((candidate) => candidate.candidateId).join("、");
  const expectedSteps = nextActProjection !== null
    ? `- move:${nextActProjection.locationId}；choices: move:${nextActProjection.locationId}_choice_1、move:${nextActProjection.locationId}_choice_2；到达 NPC: ${nextActProjection.npcId}`
    : descriptorGraph.steps.length === 0
      ? "无 continuation step。"
      : descriptorGraph.steps.map((step) => {
          const choices = step.choiceCandidates.map((candidate) => candidate.candidateId).join("、") || "无";
          return `- ${step.stepKey}；choices: ${choices}`;
        }).join("\n");
  const expectedTerminal = nextActProjection !== null
    ? { kind: "next_decision", target: { kind: "continuation_step", stepKey: `move:${nextActProjection.locationId}` } }
    : descriptorGraph.terminal;
  const currentTalkNpcIds = descriptorGraph.terminal.kind === "next_decision"
    && descriptorGraph.terminal.target.kind === "current_scene"
    ? descriptorGraph.currentChoiceCandidates
        .map((candidate) => candidate.action)
        .filter((action): action is Extract<Action, { readonly type: "talk" }> => action.type === "talk")
        .map((action) => String(action.npcId))
    : [];
  const dialogueFocusNpc = descriptorGraph.currentChoiceCandidates.length === 2
    && currentTalkNpcIds.length === 2
    && currentTalkNpcIds[0] === currentTalkNpcIds[1]
    ? worldState.npcs.find((npc) => String(npc.id) === currentTalkNpcIds[0])
    : undefined;
  return { descriptorGraph, nextActProjection, expectedChoices, expectedSteps, expectedTerminal, dialogueFocusNpc };
}

export function buildDecisionNarrativeContextBlocks(
  input: DecisionNarrativeContextInput,
): readonly NarrativeContextBlock[] {
  const { storyState, job, contentRepair } = input;
  // Prompt facts must exclusively originate from the authoritative store. The
  // legacy arrays are a compatibility read model and may never repair a
  // missing/inconsistent store projection here.
  const worldState = { ...input.worldState, ...projectEntityStore(input.worldState.entityStore) };
  const entityContext = buildEntityContextProjection({ worldState, storyState, job });
  const projection = expectedBundleProjection(worldState, storyState, job);
  const currentLocation = worldState.locations.find((location) => location.id === worldState.currentLocationId);
  const focusNpc = job.focusNpcId === undefined
    ? undefined
    : worldState.npcs.find((npc) => String(npc.id) === String(job.focusNpcId));
  const previousScene = recentScene(storyState);
  const recentBeats = storyState.recentBeats.filter(isRecentBeat).slice(-5);
  const privateFactIds = new Set(worldState.npcs.flatMap((npc) => npc.memory.hiddenFactIds.map(String)));
  const visibleFacts = worldState.worldFacts.filter((fact) =>
    fact.discovered && !privateFactIds.has(String(fact.factId)),
  );
  const activeQuest = worldState.quests.find((quest) => quest.status === "active" && quest.kind === "main");
  const style = buildStylePolicy(worldState.generation.setup);
  const expectedObjectiveLink = job.objectiveTransition.after === null
    ? "null"
    : JSON.stringify({
        questId: job.objectiveTransition.after.questId,
        objectiveIndex: job.objectiveTransition.after.objectiveIndex,
        mode: "progress",
      });
  const beatLines = job.mandatoryBeats.map((beat) => {
    const requirement = beat.beatId === ATMOSPHERE_BEAT_ID
      ? "可选，可省略；若写，必须放在所有 segments 最后"
      : "必须覆盖，恰好一次";
    return `- beatId="${beat.beatId}"（${beat.kind}，${requirement}）：${beat.instruction}`;
  }).join("\n");
  const utteranceBeat = job.mandatoryBeats.find((beat) => beat.kind === "player_utterance");
  const actionSummary = job.utterance !== undefined
    ? `玩家自定义输入：${job.utterance}`
    : job.selectedDialogue?.label !== undefined
      ? `玩家选择了选项：“${job.selectedDialogue.label}”`
      : `玩家行动：${job.actionSummary.kind}`;
  const evolutionRequirement = storyState.evolution.status === "needs_next_act"
    ? `本回合已进入第 ${storyState.currentAct} 幕：worldDelta 绝不能为 null，必须提供 newLocation、newNpc、newItem、newEnemy、nextMainQuest；其余字段可为 null。`
    : storyState.evolution.status === "needs_ending_pair"
      ? "本回合需要结局：worldDelta 绝不能为 null，且必须只提供 trust/doubt endingPair；不能创建地点、NPC、物品、敌人、任务；terminal 必须严格为 {\"kind\":\"ending\"}，continuationScenes 必须为 []。"
      : "本回合不需要世界演化：worldDelta 必须为 null。";
  const arrivalSkeleton = projection.nextActProjection === null
    ? ""
    : `下一幕抵达场景骨架：{\"stepKey\":\"move:${projection.nextActProjection.locationId}\",\"scene\":{\"segments\":[{\"beatId\":\"atmosphere\",\"text\":\"玩家抵达新地点并与新 NPC 相遇的旁白\"}],\"npcLine\":{\"npcId\":\"${projection.nextActProjection.npcId}\",\"text\":\"新 NPC 的第一人称开场对白\",\"emotion\":\"neutral\",\"answeredBeatIds\":[],\"usedFactIds\":[],\"usedInteractionActionIds\":[]},\"objectiveLink\":null,\"choices\":[{\"candidateId\":\"move:${projection.nextActProjection.locationId}_choice_1\",\"label\":\"...\"},{\"candidateId\":\"move:${projection.nextActProjection.locationId}_choice_2\",\"label\":\"...\"}]}}`;
  const genreRequirement = worldState.generation.gameType === "wuxia"
    ? "武侠写实约束：角色、冲突与叙述只能采用江湖、人事、武学、机关等武侠元素；禁止鬼魂、幽灵、灵魂、超自然、魔法、法术、咒语、法阵、圣光、精灵、异界等玄幻/西幻元素。"
    : "叙述必须严格贴合当前题材，不混入其他题材的设定。";

  const blocks: NarrativeContextBlock[] = [
    block({
      id: "bundle:rules", slot: "system_rules", title: "规则与事实优先级",
      authority: "rule", retention: "mandatory", priority: 1000,
      source: { kind: "narrative_bundle_contract", refs: [String(job.jobId)] },
      content: `你是 RPG 的叙事 AI。一次响应生成完整叙事包，只输出 JSON，不能有解释或 Markdown。规则、已提交状态、已结算节拍、服务端图与输出契约高于历史文本和当前提案；不得改写规则结果、发明实体 ID 或扩大未来步骤。\n${genreRequirement}\n战斗失败会恢复到战斗前检查点，不生成战败或撤退的永久剧情分支。`,
    }),
    block({
      id: "bundle:world-canon", slot: "world_canon", title: "世界与题材",
      authority: "lore", retention: "optional", priority: 500,
      source: { kind: "generation_metadata", refs: [] },
      content: `游戏类型=${worldState.generation.gameType}；世界前提=${worldState.generation.setup?.worldPremise ?? "沿用当前世界"}；故事开端=${worldState.generation.setup?.storyOpening ?? "沿用当前主线"}。`,
    }),
    block({
      id: "bundle:story-contract", slot: "story_contract", title: "故事契约",
      authority: "plan", retention: "mandatory", priority: 850,
      source: { kind: "story_contract", refs: [] },
      content: `中心冲突=${storyState.contract.centralConflict}；结局方向=${storyState.contract.endingDirections.map((direction) => `${direction.key}=${direction.theme}`).join("；")}。故事契约不定义当前幕数，以当前剧情状态为准。`,
    }),
    block({
      id: "bundle:current-state", slot: "current_state", title: "当前剧情状态",
      authority: "state", retention: "mandatory", priority: 900,
      source: { kind: "story_state_projection", refs: [String(job.jobId)] },
      content: `currentAct=${storyState.currentAct}；targetActs=${storyState.targetActs}；storyProgress=${storyState.storyProgress}；tension=${storyState.tension}；nextPacingNeed=${storyState.nextPacingNeed}；remainingBudget=locations:${Math.max(0, storyState.budget.locations.max - storyState.budget.locations.expanded)},npcs:${Math.max(0, storyState.budget.npcs.max - storyState.budget.npcs.expanded)},quests:${Math.max(0, storyState.budget.quests.max - storyState.budget.quests.expanded)},events:${Math.max(0, storyState.budget.events.max - storyState.budget.events.expanded)}；unresolvedThreads=${list(storyState.unresolvedThreads)}；activeQuest=${activeQuest === undefined ? "无" : `${activeQuest.name}（${activeQuest.id}，${activeQuest.status}）：${activeQuest.description}`}`,
    }),
    block({
      id: "bundle:player", slot: "current_state", title: "玩家档案",
      authority: "state", retention: "mandatory", priority: 900,
      source: { kind: "world_state_projection", refs: [] },
      content: `玩家=${worldState.player.name}（${worldState.player.identity}）。不得给玩家改名、增加未经状态批准的身份或宣称未结算的持有物。`,
    }),
    block({
      id: "bundle:visible-facts", slot: "current_state", title: "当前可见事实",
      authority: "state", retention: "mandatory", priority: 875,
      source: { kind: "public_fact_projection", refs: visibleFacts.map((fact) => String(fact.factId)) },
      content: `允许叙述的已发现公开事实：${list(visibleFacts.map((fact) => `${fact.factId}=${fact.text}`))}。其他 NPC 的私密事实正文未提供，不得自行补全。`,
    }),
    block({
      id: "bundle:resolution", slot: "current_resolution", title: "当前已结算结果",
      authority: "state", retention: "mandatory", priority: 950,
      source: { kind: "pending_narrative_job", refs: [String(job.jobId)] },
      content: `本回合强制叙事节拍（currentScene.segments 的 beatId 只能是下列之一）：\n${beatLines || "（无；只允许可选 atmosphere）"}\ncurrentScene.objectiveLink 必须严格为 ${expectedObjectiveLink}。${utteranceBeat === undefined ? "" : `\n存在 player_utterance 节拍：npcLine 必须为 npcId=\"${utteranceBeat.subjectIds[0] ?? ""}\" 的直接回应，answeredBeatIds 必须包含 \"${utteranceBeat.beatId}\"。`}${job.actionSummary.kind === "talk" && focusNpc !== undefined ? `\ncurrentScene.npcLine 必须是 ${focusNpc.name} 对本轮行动的第一人称直接回应，不能为 null。` : ""}${projection.dialogueFocusNpc === undefined ? "" : `\n当前决策点是 ${projection.dialogueFocusNpc.name} 的对话，currentScene.npcLine 必须提供其直接对白。`}`,
    }),
    block({
      id: "bundle:location", slot: "current_location", title: "当前地点",
      authority: "state", retention: "mandatory", priority: 900,
      source: { kind: "world_state_projection", refs: currentLocation === undefined ? [] : [String(currentLocation.id)] },
      content: currentLocation === undefined
        ? "当前地点缺失；不得猜测地点。"
        : `玩家当前位置：${currentLocation.name}（${currentLocation.id}）：${currentLocation.description}；已连接地点=${list(currentLocation.connectedLocationIds.map(String))}。`,
    }),
    block({
      id: "bundle:focus-npc", slot: "focus_character", title: "焦点角色",
      authority: "state", retention: "mandatory", priority: 875,
      source: { kind: "focus_npc_projection", refs: focusNpc === undefined ? [] : [String(focusNpc.id)] },
      content: focusNpcContent(worldState, job),
    }),
    block({
      id: "bundle:entity-index", slot: "current_state", title: "已批准实体索引",
      authority: "state", retention: "mandatory", priority: 825,
      source: { kind: "world_entity_index", refs: entityContext.mandatory.map((entity) => entity.id) },
      content: `已占用实体名称（新实体不得与下列任何名称重复）：\n${occupiedNamesSection(entityContext)}\n世界内实体名称唯一，新实体必须避开以上全局名称。\n规则闭包：\n${entityContext.mandatory.map((entity) => `- ${entity.kind}:${entity.id}=${entity.name}；${entity.summary}`).join("\n") || "（无）"}\n一跳相关实体：\n${entityContext.optional.map((entity) => `- ${entity.kind}:${entity.id}=${entity.name}；${entity.summary}`).join("\n") || "（无）"}\n只有规则闭包和一跳相关实体中的 ID 可作为当前场景既有实体引用；全局名称表只用于防撞名。`,
    }),
    block({
      id: "bundle:item-state", slot: "current_state", title: "物品权威状态",
      authority: "state", retention: "mandatory", priority: 875,
      source: { kind: "possession_projection", refs: [...entityContext.mandatory, ...entityContext.optional].filter((entity) => entity.kind === "item").map((entity) => entity.id) },
      content: `${itemStateSection(entityContext)}\n尚未拾取的物品只能被观察、发现或拾取；规则动作完成前，不得写成玩家已经持有、拿出或使用，也不得让选项假定玩家已经持有。`,
    }),
    block({
      id: "bundle:recent-events", slot: "relevant_events", title: "相关近期事件",
      authority: "event", retention: "optional", priority: 650,
      source: { kind: "recent_beats", refs: recentBeats.map((beat) => String(beat.turn)) },
      content: `recentBeats：\n${recentBeats.length === 0 ? "（无）" : recentBeats.map((beat) => `- turn=${beat.turn}；kind=${beat.kind}；summary=${beat.summary}`).join("\n")}`,
    }),
    block({
      id: "bundle:director-guidance", slot: "director_guidance", title: "导演与风格",
      authority: "plan", retention: "mandatory", priority: 825,
      source: { kind: "style_policy", refs: [] },
      content: `${style.narrationInstruction} ${style.intensityInstruction}\ncurrentScene 必须直接承接上一场景与玩家本轮行动，不得回到更早情节、重复上一场景开场或把玩家写回已经离开的旧地点。`,
    }),
    block({
      id: "bundle:player-action", slot: "player_action", title: "玩家本轮行动",
      authority: "state", retention: "mandatory", priority: 925,
      source: { kind: "pending_narrative_job", refs: [String(job.actionId)] },
      content: actionSummary,
    }),
    block({
      id: "bundle:legal-graph", slot: "legal_actions", title: "唯一合法续接图",
      authority: "rule", retention: "mandatory", priority: 925,
      source: { kind: "narrative_bundle_descriptors", refs: [String(job.jobId)] },
      content: `符号引用白名单：@current.location、@current.focus_npc、@new.location、@new.npc、@new.item、@new.enemy、@new.fact、@new.quest、@ending.trust、@ending.doubt。\ncontinuationScenes 必须与第 8 条投影的步骤完全一致，数量、stepKey、顺序都不得改动，不得投影之外自行规划未来步骤。\n这是服务端重建的唯一合法图，必须逐字使用 stepKey 与 candidateId，不得自创、遗漏、重复或继续规划未来：\n- terminal: ${JSON.stringify(projection.expectedTerminal)}\n- currentScene choices: ${projection.expectedChoices}\n- continuationScenes:\n${projection.expectedSteps}`,
    }),
    block({
      id: "bundle:world-evolution", slot: "director_guidance", title: "世界演化要求",
      authority: "state", retention: "mandatory", priority: 900,
      source: { kind: "story_evolution_state", refs: [] },
      content: `${evolutionRequirement}${arrivalSkeleton === "" ? "" : `\n${arrivalSkeleton}`}`,
    }),
    block({
      id: "bundle:output-contract", slot: "output_contract", title: "输出契约",
      authority: "rule", retention: "mandatory", priority: 1000,
      source: { kind: "narrative_bundle_schema", refs: [] },
      content: `返回一个 JSON 对象，顶层只有 worldDelta、currentScene、continuationScenes、terminal。\n- currentScene={segments:[{beatId,text}],npcLine:null或{npcId,text,emotion,answeredBeatIds,usedFactIds,usedInteractionActionIds},objectiveLink:null或{questId,objectiveIndex,mode},choices:[{candidateId,label}]}。\n- continuationScenes=[{stepKey,scene:与 currentScene 同形}]，必须与“唯一合法续接图”的步骤数量、stepKey 和顺序完全一致。\n- terminal 只能是 {\"kind\":\"next_decision\",\"target\":{\"kind\":\"current_scene\"}}、{\"kind\":\"next_decision\",\"target\":{\"kind\":\"continuation_step\",\"stepKey\":\"服务端步骤\"}} 或 {\"kind\":\"ending\"}。\n- 终点决策点恰好两个 choices，candidateId 逐字复制合法图；其余步骤 choices=[]。\n- npcLine 不能是字符串；emotion 只能是 neutral|warm|guarded|afraid|angry|sad；引用数组没有合法引用时输出 []。\n- 若要求 worldDelta，严格使用 {\"beatSummary\":\"...\",\"newLocation\":{\"name\":\"...\",\"description\":\"...\",\"scale\":\"scene\",\"placement\":\"world\",\"connectFromLocationId\":\"现有地点 ID\"},\"newNpc\":{\"name\":\"...\",\"role\":\"...\",\"description\":\"...\",\"locationRef\":{\"kind\":\"new_location\"},\"anchors\":{\"selfConcept\":\"...\",\"values\":[\"...\"],\"speechStyle\":\"...\",\"capabilityBoundaries\":[\"...\"],\"taboos\":[]},\"goals\":[{\"horizon\":\"short\",\"description\":\"...\",\"priority\":3,\"reason\":\"...\"}],\"relationshipSeeds\":[{\"targetNpcId\":\"既有 active NPC ID\",\"stance\":\"ally|protective_of|indebted_to|rival|wary\",\"reason\":\"...\"}]},\"newItem\":{\"name\":\"...\",\"description\":\"...\",\"locationRef\":\"new_location\"},\"newEnemy\":{\"name\":\"...\",\"tier\":\"normal\",\"locationRef\":\"new_location\"},\"newFact\":null或{\"text\":\"...\",\"visibility\":\"public或private\",\"investigationLabel\":\"可选\",\"investigationApproaches\":[{\"approachId\":\"...\",\"label\":\"...\",\"hint\":\"可选\",\"evidenceQuality\":\"clean或noisy\",\"tensionDelta\":-5到20}]},\"nextMainQuest\":{\"name\":\"...\",\"description\":\"...\",\"objectiveText\":\"...\"},\"endingPair\":null或[{\"themeKey\":\"trust\",\"name\":\"...\",\"description\":\"...\"},{\"themeKey\":\"doubt\",\"name\":\"...\",\"description\":\"...\"}]}；anchors 五个字段都必需，goals 至少 1 条且最多 4 条；relationshipSeeds 最多 4 条，每项只能包含 targetNpcId、stance、reason，targetNpcId 只能引用实体规则闭包中的既有 active NPC，stance 只能使用上述定性枚举，reason 必须非空且≤200字；不得提交 affinity、stage、evidence 或 actionId；goalId/status 由服务端生成，禁止输出。未要求字段必须为 null。\n- nextMainQuest 回合 currentScene.choices=[]，唯一 continuationScenes[0] 必须使用抵达骨架。所有玩家可见文本必须为中文。`,
    }),
  ];

  if (previousScene !== null) {
    blocks.push(block({
      id: "bundle:previous-scene", slot: "recent_scenes", title: "上一场景",
      authority: "event", retention: "mandatory", priority: 875,
      source: { kind: "narrative_runtime", refs: [] },
      content: `上一场景旁白：${clipText(previousScene.narration, 500)}${previousScene.npcLine === null ? "" : `\n上一场景台词：${clipText(previousScene.npcLine.text, 200)}`}`,
    }));
  }
  if (contentRepair !== undefined) {
    blocks.push(block({
      id: "bundle:repair", slot: "current_resolution", title: "上一轮拒绝与内容修复",
      authority: "state", retention: "mandatory", priority: 950,
      source: { kind: "narrative_bundle_repair", refs: [String(job.jobId)] },
      content: repairInstruction(contentRepair),
    }));
  }
  for (const entity of entityContext.optional) {
    blocks.push(block({
      id: `bundle:entity:${entity.kind}:${entity.id}`, slot: "current_state", title: "一跳相关实体",
      authority: "state", retention: "optional", priority: 500,
      source: { kind: "entity_context_projection", refs: [entity.id, ...(entity.locationId === undefined ? [] : [entity.locationId])] },
      content: `${entity.kind}:${entity.id}=${entity.name}；${entity.summary}。`,
    }));
  }
  return blocks;
}

export function compileDecisionNarrativeContext(
  input: DecisionNarrativeContextInput,
): NarrativePromptCompilation {
  return createNarrativePromptCompilation(compileNarrativeContext({
    maxEstimatedTokens: NARRATIVE_BUNDLE_CONTEXT_MAX_ESTIMATED_TOKENS,
    blocks: buildDecisionNarrativeContextBlocks(input),
  }));
}
