import { ATMOSPHERE_BEAT_ID } from "@/game/domain/narrativeBeat";
import { isFinalDialogueHandoff, type SceneGenerationContext } from "@/game/application/sceneGenerationContext";
import type { SceneChoiceCandidate } from "@/game/application/sceneChoiceCandidates";
import type { PreparedStepDescriptor } from "@/game/gameplay/rpg/preparedContinuation";
import { compileNarrativeContext } from "./compileNarrativeContext";
import type { NarrativeContextBlock, NarrativePromptCompilation } from "./contextBlock";
import { createNarrativePromptCompilation } from "./renderNarrativeContext";

export const SCENE_CONTEXT_MAX_ESTIMATED_TOKENS = 8_000;

type SceneBlockInput = Omit<NarrativeContextBlock, "id" | "title" | "source"> & Readonly<{
  id: string;
  title: string;
  sourceKind: string;
  sourceRefs?: readonly string[];
}>;

function sceneBlock(input: SceneBlockInput): NarrativeContextBlock {
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

function describeChoiceCandidate(candidate: SceneChoiceCandidate): string {
  return `${candidate.candidateId}:${JSON.stringify(candidate.action)}`;
}

function factCards(cards: readonly { readonly factId: string; readonly text: string }[]): string {
  return cards.map((fact) => `${fact.factId}=${fact.text}`).join("；") || "无";
}

function visibleFactCards(context: SceneGenerationContext) {
  const byId = new Map<string, { readonly factId: string; readonly text: string }>();
  for (const fact of context.publicWorldFacts) byId.set(String(fact.factId), fact);
  // 当前场景的可见投影比一般公开事实更接近本轮表演，重复时必须优先保留它。
  for (const fact of context.sceneVisibleFacts) byId.set(String(fact.factId), fact);
  return [...byId.values()];
}

function genreContract(context: SceneGenerationContext): string {
  return context.gameType === "wuxia"
    ? "题材锁定为武侠：对白和旁白只能使用江湖、门派、镖局、官府、山川、兵器、线索、武学语汇；不得出现魔法、巫师、精灵、骑士、幽灵/灵魂、祭坛、法阵、圣光、异界等奇幻或超自然词汇。"
    : `题材锁定为${context.gameType ?? "当前游戏"}，不得跨题材改写世界规则。`;
}

function objectiveMode(context: SceneGenerationContext): "handoff" | "progress" | "hint" {
  if (context.objectiveTransition.mode === "advanced_act") return "handoff";
  return context.objectiveTransition.completed.length > 0 ? "progress" : "hint";
}

function mandatoryBeatContent(context: SceneGenerationContext): { readonly beats: string; readonly segmentInstruction: string } {
  if (context.mandatoryBeats.length > 0) {
    return {
      beats: context.mandatoryBeats.map((beat) => `- ${beat.beatId} [${beat.kind}] ${beat.instruction}`).join("\n"),
      segmentInstruction: "segments 逐条覆盖【已解决的本轮规则结果节拍】中的每个节拍并被其 beatId 点名；可额外附加一条 beatId 为 atmosphere 的氛围段，且必须放在最后；自创节拍 ID 非法。",
    };
  }
  return {
    beats: `- ${ATMOSPHERE_BEAT_ID} [atmosphere] 只描写玩家此刻在当前地点的即时感官体验：视觉、声音、气味、温度、触感或空间细节；让玩家感到“我现在就在这里”，不要重新解释序幕中的背景、动机或主线冲突。`,
    segmentInstruction: `当前没有其他强制节拍：segments 必须且只能返回一条 beatId 为 ${ATMOSPHERE_BEAT_ID} 的开场氛围段；不得返回空数组或自创 beatId。`,
  };
}

function repairInstruction(context: SceneGenerationContext): string {
  const reason = context.repairAttempt?.reason;
  if (reason === undefined) return "";
  switch (reason) {
    case "segment_unknown_beat": {
      const allowedBeatIds = [
        ...new Set([
          ...context.mandatoryBeats.map((beat) => beat.beatId),
          ATMOSPHERE_BEAT_ID,
        ]),
      ];
      return `上次失败字段：segments[].beatId 使用了未授权节拍。segments[].beatId 只能逐字复制允许列表 [${allowedBeatIds.join(", ")}]; 禁止使用 actionId、jobId、questId 或任何自创 ID。`;
    }
    case "segments_empty":
      return `上次失败字段：segments 为空。必须返回至少一段，并使用允许的 beatId；当前无强制节拍时只能返回 ${ATMOSPHERE_BEAT_ID}。`;
    case "invalid_json":
      return "上次失败：响应不是可解析的完整 JSON。只返回一个 JSON 对象，不要加解释文字或 Markdown 围栏。";
    case "root_not_object":
      return "上次失败：JSON 根节点不是对象。只返回契约要求的 JSON 对象。";
    case "choices_stale_template":
      return "上次失败：choices 沿用了上一轮或旧模板文案。保留服务端给出的 candidateId，但根据本轮 NPC 回应重写两个具体、可执行的选项 label。";
    default:
      return `上次失败字段：${reason}。只修复该契约问题，其他主线、NPC、历史对话和事实边界保持不变。`;
  }
}

function focusContent(context: SceneGenerationContext): string {
  const focus = context.focusNpcContext;
  if (focus === undefined) return "无焦点 NPC；npcLine 必须为 null。";
  const authority = focus.speechAuthority;
  if (authority === undefined || focus.identityAnchors === undefined) {
    const interactions = focus.recentInteractions
      .map((interaction) => `${interaction.actionId}：dialogueAct=${interaction.dialogueAct}；topicSummary=${interaction.topicSummary}；outcome=${interaction.outcome}；summary=${interaction.summary}`)
      .join("\n") || "无（usedInteractionActionIds 必须为 []）";
    return `id=${focus.id}；${focus.name}（${focus.role}）；公开档案=${focus.publicProfile}；\n` +
      `回应政策：tier=${focus.responsePolicy.tier}；tone=${focus.responsePolicy.toneInstruction}；initiative=${focus.responsePolicy.initiative}；允许披露事实 ID=[${focus.responsePolicy.allowedDisclosureFactIds.join(", ")} ]；私密知识必须扣留，正文不得编造或泄露；\n` +
      `目标=${focus.goals.join("、") || "无"}；情绪=${focus.emotion}；thisTurn.outcome=${focus.thisTurn.outcome}；\n` +
      `可说线索卡：${factCards(focus.speakableFactCards)}；\n` +
      `最近结构化交互（最多 5 条）：\n${interactions}`;
  }
  const anchors = authority.identityAnchors;
  const relations = authority.relationships
    .filter((relation) => context.presentNpcs.some((npc) => String(npc.id) === String(relation.targetId)) || String(relation.targetId) === "player_0")
    .map((relation) => `${relation.targetId}：stage=${relation.stage}；trend=${relation.trend}；openCommitments=${relation.openCommitments.map((commitment) => `${commitment.kind}:${commitment.description}`).join("、") || "无"}`)
    .join("\n") || "无明确相关关系";
  const interactions = focus.recentInteractions
    .map((interaction) => `${interaction.actionId}：dialogueAct=${interaction.dialogueAct}；topicSummary=${interaction.topicSummary}；outcome=${interaction.outcome}；summary=${interaction.summary}`)
    .join("\n") || "无（usedInteractionActionIds 必须为 []）";
  return `id=${focus.id}；${focus.name}（${focus.role}）；公开档案=${focus.publicProfile}；\n` +
    `人格锚点：selfConcept=${anchors.selfConcept}；values=${anchors.values.join("、") || "无"}；speechStyle=${anchors.speechStyle}；capabilityBoundaries=${anchors.capabilityBoundaries.join("、") || "无"}；taboos=${anchors.taboos.join("、") || "无"}；\n` +
    `回应政策：tier=${focus.responsePolicy.tier}；tone=${focus.responsePolicy.toneInstruction}；initiative=${focus.responsePolicy.initiative}；允许披露事实 ID=[${authority.allowedFactIds.join(", ")}]；私密知识必须扣留，正文不得编造或泄露；\n` +
    `目标=${authority.activeGoals.join("、") || "无"}；情绪=${focus.emotion}；thisTurn.outcome=${focus.thisTurn.outcome}；\n` +
    `相关关系：\n${relations}\n证据 keys=[${authority.evidenceKeys.join(", ") || "无"}]；\n` +
    `可说线索卡：${factCards(authority.allowedFactCards)}；\n` +
    `最近结构化交互（最多 5 条）：\n${interactions}`;
}

function previousDialogueContent(context: SceneGenerationContext): string | undefined {
  if (context.previousDialogue === undefined) return undefined;
  return `上一轮 NPC 原话=${context.previousDialogue.npcLine}；` +
    `玩家上一轮选择=${context.previousDialogue.selectedChoice?.label ?? "自定义回应"}；` +
    `结构化回应=${context.previousDialogue.selectedChoice?.dialogueAct ?? "ask"}；` +
    `主题=${context.previousDialogue.selectedChoice?.topic?.kind ?? "general"}；` +
    `上一轮已引用事实=${context.previousDialogue.usedFactIds?.join("、") || "无"}。`;
}

function preparedStepAction(descriptor: PreparedStepDescriptor): string {
  switch (descriptor.trigger.kind) {
    case "move": return `move(locationId=${descriptor.trigger.locationId})`;
    case "investigate": return `investigate(factId=${descriptor.trigger.factId}${descriptor.trigger.approachId === undefined ? "" : `；approachId=${descriptor.trigger.approachId}`})`;
    case "battle_started": return `battle_started(enemyId=${descriptor.trigger.enemyId})`;
    case "battle_resolved": return `battle_resolved(enemyId=${descriptor.trigger.enemyId}；outcome=${descriptor.trigger.outcome})`;
  }
}

function preparedStepDescriptorContent(descriptor: PreparedStepDescriptor): string {
  const arrival = descriptor.arrivalNpc === undefined
    ? "arrivalNpc=无；choices=[]"
    : `arrivalNpc=${descriptor.arrivalNpc.id}（${descriptor.arrivalNpc.name}；${descriptor.arrivalNpc.role}；公开身份=${descriptor.arrivalNpc.publicProfile}；可说事实=${factCards(descriptor.arrivalNpc.knownFactCards)}）；合法 choices=${descriptor.choiceCandidates.map((candidate) => describeChoiceCandidate({
      candidateId: candidate.candidateId,
      label: "",
      action: candidate.action,
    })).join("；") || "无"}`;
  return `- stepId=${descriptor.stepId}；action=${preparedStepAction(descriptor)}；objectiveKey=${descriptor.objectiveKey}；允许实体=[${descriptor.authority.allowedEntityIds.join(", ")}]；${arrival}`;
}

function preparedContinuationsContent(descriptors: readonly PreparedStepDescriptor[]): string {
  if (descriptors.length === 0) return "服务端 descriptor 列表为空；preparedContinuations 必须输出 []。";
  const arrivalSteps = descriptors.filter((descriptor) => descriptor.arrivalNpc !== undefined);
  return `服务端 descriptor 列表（只读，必须逐条使用）：\n${descriptors.map(preparedStepDescriptorContent).join("\n")}\n` +
    `输出契约：每个 descriptor 恰好生成一个 preparedContinuations 条目，stepId 必须逐字复制且不得新增、遗漏或重复；${arrivalSteps.length === 0 ? "当前没有 arrival step。" : "arrival step 必须恰好生成两个 choices，且 candidateId 必须逐字使用该 descriptor 的两个合法候选。"}非 arrival step 的 choices 必须为 []。每个条目的字段只允许 stepId、segments、npcLine、objectiveLink、choices；图结构和消费状态由服务端保留，AI 不得追加服务端元数据字段。不得捏造新事实、新实体或具体时间，不得输出系统元话术。`;
}

function preparedContinuationsJsonShape(descriptors: readonly PreparedStepDescriptor[]): string {
  const entries = descriptors.map((descriptor) => {
    const arrival = descriptor.arrivalNpc !== undefined;
    const choices = arrival
      ? `[{"candidateId":"${descriptor.choiceCandidates[0]?.candidateId ?? "第一个合法候选ID"}","label":"玩家对白或动作"},{"candidateId":"${descriptor.choiceCandidates[1]?.candidateId ?? "第二个合法候选ID"}","label":"另一句玩家对白或动作"}]`
      : "[]";
    const npcLine = arrival
      ? `{"npcId":"${descriptor.arrivalNpc?.id ?? "目标 NPC ID"}","text":"抵达后目标 NPC 的两句直接对白","emotion":"neutral","answeredBeatIds":[],"usedFactIds":[],"usedInteractionActionIds":[]}`
      : "null";
    return `{"stepId":"${descriptor.stepId}","segments":[{"beatId":"${ATMOSPHERE_BEAT_ID}","text":"续行场景正文"}],"npcLine":${npcLine},"objectiveLink":null或{"questId":"${descriptor.authority.questId}","objectiveIndex":${descriptor.authority.objectiveIndex},"mode":"hint"},"choices":${choices}}`;
  }).join(",");
  return `"preparedContinuations":[${entries}]`;
}

export function buildSceneNarrativeContextBlocks(
  context: SceneGenerationContext,
  selectable: readonly SceneChoiceCandidate[],
): readonly NarrativeContextBlock[] {
  const { story, job } = context;
  const focus = context.focusNpcContext;
  const preparedDescriptors = context.preparedStepDescriptors ?? [];
  const beats = mandatoryBeatContent(context);
  const after = context.objectiveTransition.after;
  const utteranceBeat = context.mandatoryBeats.find((beat) => beat.kind === "player_utterance");
  const nonFocus = context.presentNpcs
    .filter((npc) => String(npc.id) !== String(focus?.id))
    .map((npc) => `${npc.id}=${npc.name}（${npc.role}；公开身份=${npc.publicProfile}）`);
  const activeQuest = story.activeQuest === undefined
    ? "无已解析的当前主线摘要；沿用目标转换和 NPC 可说事实。"
    : `主线=${story.activeQuest.name}；主线说明=${story.activeQuest.description}；当前目标=${story.activeQuest.objectiveLabel}（${story.activeQuest.objectiveKind}，序号${story.activeQuest.objectiveIndex}）`;
  const allowedFactIds = focus?.speechAuthority?.allowedFactIds.map(String) ?? focus?.speakableFactCards.map((fact) => String(fact.factId)) ?? [];
  const allowedInteractionIds = focus?.speechAuthority?.allowedInteractionActionIds ?? focus?.recentInteractions.map((interaction) => interaction.actionId) ?? [];
  const objective = after === null
    ? "无当前目标；objectiveLink 必须为 null。"
    : `当前目标：${after.label}；objectiveLink 必须为 {"questId":"${after.questId}","objectiveIndex":${after.objectiveIndex},"mode":"${objectiveMode(context)}"}。`;
  const investigation = context.resolvedInvestigation === undefined
    ? "本轮没有已结算的调查结果节拍。"
    : `本轮调查已结算（服务端权威，AI 不得更改）：所选方式=${context.resolvedInvestigation.approachLabel}；证据质量=${context.resolvedInvestigation.evidenceQuality === "clean" ? "干净无扰" : "留有动静暴露"}；${context.objectiveTarget === null ? "" : `下一目标=${context.objectiveTarget.entityName}；`}fact_discovered 节拍的 segment.text 必须点名方式「${context.resolvedInvestigation.approachLabel}」，只叙述该已结算结果，不得决定是否发现事实，不得声称与证据质量相反的动静，不得修改张力。`;
  const utteranceContract = utteranceBeat === undefined
    ? "本轮没有玩家原话节拍。"
    : `本轮玩家原话节拍的精确 beatId 是 ${utteranceBeat.beatId}；npcLine.npcId 必须是 ${utteranceBeat.subjectIds[0] ?? "焦点 NPC"}，answeredBeatIds 必须精确包含 ["${utteranceBeat.beatId}"]。`;
  const handoffContract = context.objectiveTransition.mode !== "advanced_act" || context.objectiveTarget === null
    ? ""
    : `quest_advanced 是幕交接节拍；objectiveLink 已由服务端锁定。${focus === undefined ? "本轮没有旧焦点 NPC，不生成旧 NPC 交接台词。" : `npcLine.npcId 必须是旧焦点 NPC ${focus.id}；这名 NPC 的最后一句必须自然引出「${context.objectiveTarget.entityName}」，不得把 npcLine 切换给新目标 NPC。`}请用自然语言表达线索如何把玩家带向新目标，不要输出系统元话术；quest_advanced segment 的 referencedEntityIds 必须包含精确目标实体 ID ${context.objectiveTarget.entityId}。`;
  const nonFocusContract = nonFocus.length === 0
    ? "非焦点 NPC 同步闲聊：无非焦点 NPC，输出 npcDialogues=[]。"
    : `非焦点 NPC 同步闲聊：为以下每个非焦点在场 NPC 各生成一条直接闲聊：${nonFocus.join("；")}。`;
  const previousDialogue = previousDialogueContent(context);
  const finalDialogueHandoff = isFinalDialogueHandoff(context);
  const choiceShape = finalDialogueHandoff
    ? "\"choices\":[],\"handoffAcknowledgement\":\"玩家对当前 NPC 的具体致意\""
    : "\"choices\":[{\"candidateId\":\"选项ID\",\"label\":\"玩家行动\"},{\"candidateId\":\"另一选项ID\",\"label\":\"玩家行动\"}]";
  const finalDialogueContract = finalDialogueHandoff
    ? "本轮是上一名 NPC 对话的收尾：npcLine 是该 NPC 的最后一句直接回应；final handoff 必须返回零个当前 choices，并且恰好返回一个 handoffAcknowledgement，作为玩家对该 NPC 的具体致意。不要返回任何当前可执行选项，不要返回“知道了”、纯确认或脱离上下文的继续调查。"
    : "普通场景必须返回两个语义不同的合法当前 choices，且不得返回 handoffAcknowledgement；两个选项都要直接回应本轮 NPC 台词，并至少一个推进当前主线目标。";
  const outputContract = [
    `JSON={"segments":[{"beatId":"必须从上面节拍列表逐字复制的ID","text":"旁白","referencedEntityIds":["可选的服务端实体ID"]}],"npcLine":null或{"npcId":"在场ID","text":"第一句直接回应。第二句补充线索或下一步。","emotion":"neutral","answeredBeatIds":[],"usedFactIds":[],"usedInteractionActionIds":[]},"npcDialogues":[{"npcId":"非焦点在场NPC ID","text":"一句到两句符合身份和当前场景的直接闲聊"}],"objectiveLink":null或{"questId":"目标questId","objectiveIndex":0,"mode":"hint"},${choiceShape},${preparedContinuationsJsonShape(preparedDescriptors)}}`,
    beats.segmentInstruction,
    finalDialogueContract,
    `NPC 台词硬约束：有焦点 NPC 时 npcLine 不能为 null，text 必须恰好包含两句以“。”、“！”或“？”结尾的直接对白；两句之间用中文句号分隔。不要使用任何引号、角色名、动作、表情或“说道/答道”等舞台说明，不要用分号代替第二句。${previousDialogue === undefined ? "无上一轮 NPC 对话；这是当前对话的开场。" : `${previousDialogue}\n若有上一轮 NPC 原话，必须先直接承接其中的问题、信息或拒答，再补充本轮可核验线索或下一步；不得突然切换到无关案件。`}若有 player_utterance，answeredBeatIds 必须包含对应的精确 beatId，并由该焦点 NPC 先回应玩家，再给出可核验线索或下一步。不得说“想听哪一段/想问什么/我知道了”。只能说 NPC 可说线索，不能编造私密知识。任何具体地点、人物、时间、物品或证物，都必须能在主线剧情摘要、NPC 可说事实或场景可见事实中找到依据；如果没有依据，只能使用当前 objectiveLink/目标实体给出的下一步，不得自行补出新的核验细节。非焦点 npcDialogues 中每条 text 必须是直接闲聊，不得包含任务推进、私密事实、动作旁白或通用兜底句。选项生成顺序：先完成 npcLine，再根据本轮 npcLine 的文本和 usedFactIds 生成 choices；上一轮选择只用于理解承接关系，不得直接复用为本轮可见选项。choices 的 candidateId 必须逐字使用上方候选动作中的合法 ID；候选动作只提供服务端合法的 candidateId 和动作语义，不提供可直接复用的自然语言选项。label 是玩家实际要说的话或动作，不要加“回应某人/追问某人”等前缀，不要机械复述 NPC 原话；动作选项必须用全角括号包裹。${finalDialogueHandoff ? "final handoff 的 handoffAcknowledgement 必须是玩家对当前 NPC 的具体致意，不得是可执行 choice。" : "请依据主线剧情上下文、NPC 可说事实和本轮台词写出两句自然、具体、互不重复的玩家对白或动作。"}`,
    `ID 复核：segments.beatId 只能逐字复制“已解决的本轮规则结果节拍”列表中的 ID，禁止创造 item_given、dialogue_response 等新 ID；segments.referencedEntityIds 只能从 [${(context.narrativeReferenceIds ?? []).join(", ")}] 选择；npcLine.usedFactIds 只能从 [${allowedFactIds.join(", ")}] 选择，npcLine.usedInteractionActionIds 只能从 [${allowedInteractionIds.join(", ")}] 选择；没有对应引用时必须输出空数组。输出前逐项核对这些 ID。玩家可见旁白必须是连续、具体的剧情正文；不得输出“主线推进到第X幕”“已完成：”“当前目标：”等系统元话术，任务状态由 HUD 单独展示。`,
  ].join("\n");
  const blocks: NarrativeContextBlock[] = [
    sceneBlock({
      id: "scene:rules", slot: "system_rules", title: "规则与事实优先级", sourceKind: "scene_generation_context", sourceRefs: [String(job.jobId)],
      authority: "rule", retention: "mandatory", priority: 1000,
      content: `只输出 JSON，不能有解释或 Markdown。写一幕 RPG 场景，不得改规则。当前已结算结果、强制节拍、目标链接、合法候选动作与 ID 白名单均为服务端权威；不得改写已结算结果或创造规则事实。\n${genreContract(context)}`,
    }),
    sceneBlock({
      id: "scene:world-canon", slot: "world_canon", title: "世界与题材", sourceKind: "scene_generation_context", sourceRefs: [],
      authority: "lore", retention: "optional", priority: 500,
      content: `游戏类型=${context.gameType ?? "当前游戏"}；世界背景=${context.worldPremise ?? "沿用当前世界"}；故事开端=${context.storyOpening ?? "沿用当前主线"}`,
    }),
    sceneBlock({
      id: "scene:world-constraints", slot: "system_rules", title: "世界与题材", sourceKind: "scene_generation_context", sourceRefs: [],
      authority: "rule", retention: "mandatory", priority: 825,
      content: `世界约束：${context.worldConstraints.join("；") || "无额外世界约束。"}\n${genreContract(context)}`,
    }),
    sceneBlock({
      id: "scene:story-contract", slot: "story_contract", title: "故事契约", sourceKind: "story_contract", sourceRefs: [],
      authority: "plan", retention: "mandatory", priority: 850,
      content: `中心冲突=${story.contract.centralConflict}；结局方向=${story.contract.endingDirections.map((direction) => `${direction.key}=${direction.theme}`).join("；") || "无"}。故事契约不定义当前幕数；以当前剧情状态为准。`,
    }),
    sceneBlock({
      id: "scene:current-state", slot: "current_state", title: "当前剧情状态", sourceKind: "scene_generation_context", sourceRefs: [String(job.jobId)],
      authority: "state", retention: "mandatory", priority: 900,
      content: `currentAct=${story.currentAct}；targetActs=${story.targetActs}；tension=${story.tension}；nextPacingNeed=${story.nextPacingNeed}；remainingBudget=locations:${story.remainingBudget.remainingLocations},npcs:${story.remainingBudget.remainingNpcs},events:${story.remainingBudget.remainingEvents}；activeQuest=${activeQuest}；unresolvedThreads=${story.unresolvedThreadSummaries.join("；") || "无"}。`,
    }),
    sceneBlock({
      id: "scene:player", slot: "current_state", title: "玩家档案", sourceKind: "scene_generation_context", sourceRefs: [],
      authority: "state", retention: "mandatory", priority: 900,
      content: `玩家角色=${context.player.name}（${context.player.identity}）；已知安全事实卡=${factCards(context.player.knownFactCards)}。玩家只能被称为“${context.player.name}”，不得使用其他姓名、姓氏、代号或未经上下文批准的身份称呼。`,
    }),
    sceneBlock({
      id: "scene:visible-facts", slot: "current_state", title: "当前可见事实", sourceKind: "scene_generation_context", sourceRefs: visibleFactCards(context).map((fact) => String(fact.factId)),
      authority: "state", retention: "mandatory", priority: 875,
      content: `当前安全可见事实卡（按 factId 去重，场景投影优先）：${factCards(visibleFactCards(context))}。`,
    }),
    sceneBlock({
      id: "scene:resolution", slot: "current_resolution", title: "当前已结算结果", sourceKind: "pending_narrative_job", sourceRefs: [String(job.jobId)],
      authority: "state", retention: "mandatory", priority: 950,
      content: `已解决的本轮规则结果节拍：\n${beats.beats}\n${objective}\n调查结果=${investigation}\n${utteranceContract} ${handoffContract}`,
    }),
    sceneBlock({
      id: "scene:location", slot: "current_location", title: "当前地点", sourceKind: "scene_generation_context", sourceRefs: [String(context.currentLocation.id)],
      authority: "state", retention: "mandatory", priority: 900,
      content: `地点=${context.currentLocation.name}：${context.currentLocation.description}；类型=${context.currentLocation.kind}。`,
    }),
    sceneBlock({
      id: "scene:focus-npc", slot: "focus_character", title: "焦点角色", sourceKind: "focus_npc_context", sourceRefs: focus === undefined ? [] : [String(focus.id)],
      authority: "state", retention: "mandatory", priority: 875,
      content: focusContent(context),
    }),
    sceneBlock({
      id: "scene:recent-events", slot: "relevant_events", title: "相关近期事件", sourceKind: "recent_beats", sourceRefs: context.recentBeats.map((beat) => String(beat.turn)),
      authority: "event", retention: "optional", priority: 650,
      content: `recentBeats：${context.recentBeats.map((beat) => `turn=${beat.turn}；kind=${beat.kind}；summary=${beat.summary}`).join("\n") || "无"}`,
    }),
    sceneBlock({
      id: "scene:style-policy", slot: "director_guidance", title: "导演与风格", sourceKind: "style_policy", sourceRefs: [],
      authority: "plan", retention: "mandatory", priority: 825,
      content: `风格=${story.stylePolicy.narration}，${story.stylePolicy.narrationInstruction} ${story.stylePolicy.intensityInstruction}\natmosphere 段只负责当前地点的临场感：使用具体的视觉、声音、气味、温度、触感或空间细节，表现此刻玩家正在经历什么。不要复述 prologue 的故事钩子、背景冲突或玩家动机，不要引入未经服务端批准的新地点、NPC、物品、事实或任务；它不能替代规则节拍，也不能创造剧情事实。`,
    }),
    sceneBlock({
      id: "scene:player-action", slot: "player_action", title: "玩家本轮行动", sourceKind: "pending_narrative_job", sourceRefs: [String(job.actionId)],
      authority: "state", retention: "mandatory", priority: 925,
      content: `当前回合=${job.actionId}（${job.actionSummary.kind}）；本轮输入=${job.utterance?.trim() || "无"}。`,
    }),
    sceneBlock({
      id: "scene:legal-actions", slot: "legal_actions", title: "合法候选动作", sourceKind: "scene_choice_candidates", sourceRefs: selectable.map((candidate) => candidate.candidateId),
      authority: "rule", retention: "mandatory", priority: 925,
      content: `候选动作=${selectable.map(describeChoiceCandidate).join("；")}\n${nonFocusContract}\n闲聊只用于零回合展示，不推进任务、不改变规则、不泄露私密事实、不创造当前上下文之外的人物地点证物；可以承接当前地点和公开身份，但不要抢先替焦点 NPC 回答主线。`,
    }),
    sceneBlock({
      id: "scene:output-contract", slot: "output_contract", title: "输出契约", sourceKind: "scene_schema", sourceRefs: [],
      authority: "rule", retention: "mandatory", priority: 1000,
      content: outputContract,
    }),
  ];

  if (nonFocus.length > 0) {
    blocks.push(sceneBlock({
      id: "scene:non-focus-npcs", slot: "current_state", title: "在场非焦点角色", sourceKind: "scene_generation_context", sourceRefs: nonFocus,
      authority: "state", retention: "optional", priority: 450,
      content: `在场非焦点 NPC（仅公开资料）：${nonFocus.join("；")}。`,
    }));
  }
  if (previousDialogue !== undefined) {
    blocks.push(sceneBlock({
      id: "scene:previous-dialogue", slot: "recent_scenes", title: "上一轮对话", sourceKind: "previous_dialogue", sourceRefs: [String(context.previousDialogue!.npcId)],
      authority: "event", retention: "mandatory", priority: 875, content: previousDialogue,
    }));
  }
  if (preparedDescriptors.length > 0) {
    blocks.push(sceneBlock({
      id: "scene:prepared-continuations", slot: "director_guidance", title: "导演与风格", sourceKind: "prepared_step_descriptors", sourceRefs: preparedDescriptors.map((descriptor) => descriptor.stepId),
      authority: "state", retention: "mandatory", priority: 875, content: preparedContinuationsContent(preparedDescriptors),
    }));
  }
  if (context.repairAttempt !== undefined) {
    blocks.push(sceneBlock({
      id: "scene:repair", slot: "current_resolution", title: "当前已结算结果", sourceKind: "scene_generation_repair", sourceRefs: [String(job.jobId)],
      authority: "state", retention: "mandatory", priority: 950,
      content: `这是同一回合的第${context.repairAttempt.attempt + 1}次内容生成。上一次提案未通过${context.repairAttempt.reason}。${repairInstruction(context)} 请保留当前主线、NPC、历史对话和事实边界。`,
    }));
  }
  return blocks;
}

export function compileSceneNarrativeContext(
  context: SceneGenerationContext,
  selectable: readonly SceneChoiceCandidate[],
): NarrativePromptCompilation {
  return createNarrativePromptCompilation(compileNarrativeContext({
    maxEstimatedTokens: SCENE_CONTEXT_MAX_ESTIMATED_TOKENS,
    blocks: buildSceneNarrativeContextBlocks(context, selectable),
  }));
}
