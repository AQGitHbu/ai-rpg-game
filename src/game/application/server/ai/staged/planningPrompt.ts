// staged planning prompt（Spec 2026-09-09 / Plan Task 5 Step 3，Task 12 Step 4 补全契约）。
//
// planning 产骨架和完整内容草稿：PlanProposal 不含最终展示文本。prompt 携带预算上限、
// 公开/私密事实分区、已选 branch、必选节拍与（开局链路的）玩家设定风格段；
// 私密事实只给 planner 供结构化引用，最终表达阶段按 SafeContext 重新投影。
//
// 契约段的枚举值一律从 domain 常量取值（DIALOGUE_ACTS、BEAT_KINDS 等），
// 不写字面量：parser 白名单改了而这里没改，`planningPromptContract.test.ts`
// 会立刻失败，避免「prompt 与 parser 漂移」这类静默缺陷再次出现。

import { renderAiRepairFeedback, type AiContentRepair } from "@/game/application/aiGenerationRetry";
import { renderOpeningSetupSection } from "../openingNarrativePrompt";
import { MAX_PLAN_UNITS } from "@/game/domain/narrativePlan";
import { MAX_NARRATIVE_BUNDLE_STEPS } from "@/game/domain/narrativeBundle";
import { DIALOGUE_ACTS } from "@/game/domain/action";
import { buildNarrativeBundleDescriptors } from "@/game/gameplay/rpg/narrativeBundle";
import { buildEntityContextProjection } from "@/game/application/entityContextProjection";
import { stagedEvolutionNeed } from "@/game/application/narrativeGeneration/approvePlanningContext";
import { planningSceneContract } from "@/game/application/narrativeGeneration/planningSceneContract";
import {
  MAX_APPROACH_COUNT,
  MAX_TENSION_DELTA,
  MIN_APPROACH_COUNT,
  MIN_TENSION_DELTA,
  WORLD_DELTA_MAX_NAME,
  WORLD_DELTA_MAX_TEXT,
} from "@/game/domain/worldDeltaProposal";
import {
  NPC_ANCHOR_LIST_MAX,
  NPC_ANCHOR_LIST_MIN,
  NPC_CREATION_TEXT_MAX_LENGTH,
  NPC_GOAL_HORIZONS,
  NPC_GOAL_LIST_MAX,
  NPC_GOAL_LIST_MIN,
  NPC_GOAL_PRIORITIES,
  NPC_RELATIONSHIP_SEED_LIST_MAX,
  NPC_RELATIONSHIP_SEED_STANCES,
  NPC_TABOO_LIST_MIN,
} from "@/game/domain/entity";
import { previousDialogue } from "@/game/application/narrativeGeneration/dialogueContext";
import type { PlanningContext } from "@/game/application/narrativeGeneration/stageSource";
import type { FactEntityRecord, NpcEntityRecord } from "@/game/domain/entity";

/** 与 parseSafeBeat 的 BEAT_KIND_EXHAUSTIVE 同源；此处按语义分组便于模型取用。 */
export const PLANNING_BEAT_KINDS = [
  "player_utterance",
  "item_obtained",
  "fact_discovered",
  "quest_progress",
  "quest_advanced",
  "battle_started",
  "battle_round",
  "battle_resolved",
  "entity_introduced",
  "atmosphere",
] as const;

/** 与 parseTrigger 的 switch 分支同源。 */
export const PLANNING_TRIGGER_KINDS = [
  "move",
  "explore",
  "investigate",
  "take_item",
  "give_item",
  "battle_started",
  "battle_resolved",
] as const;

/** 与 parseRouteTarget 的 ROUTE_TARGET_KINDS 同源。 */
export const PLANNING_ROUTE_TARGET_KINDS = [
  "talk_to_npc",
  "visit_location",
  "obtain_item",
  "discover_fact",
  "defeat_enemy",
] as const;

/** 与 parseTopic 的 kind 分支同源。 */
export const PLANNING_TOPIC_KINDS = ["general", "fact", "quest", "thread"] as const;

/** 与 COSMETIC_ACTION_KINDS 同源。 */
export const PLANNING_COSMETIC_ACTION_KINDS = ["pause", "look", "gesture"] as const;

/** 内容职责只在系统消息中定义一次；用户消息提供结构契约和本轮资料。 */
export const PLANNING_CONTENT_RULES = `你是 RPG 的完整场景作者。一次写出本轮旁白、NPC 完整回应和两个有意义的玩家直接回复，保存为 unit.draft；三个润色器只改变措辞。
先保留玩家明确输入与已发生的原因，确定当下处境和 NPC 的需求，再写完整场景和两个回应。后续问答以玩家实际选中的 label 原句为准；历史仅用于连贯和避免重复，不授予新事实。
character.parts 只写 NPC 第一人称直接台词，自然回答真实问题，长度服从内容与角色语气；不夹第三人称动作说明或旁白。获批表演动作只放 actions，不写未提交的递物、转移或身体结果；同场同 NPC 恰好一次完整回应。缺答案时准确说不知道什么，不改为失忆、拒答或未曾发生；不编理由或设备。NPC 自己的问句保持是问句。
旁白交代获批变化和必选节拍，NPC 承担回答与态度，避免无意义复述。无新状态时可以一句自然衔接。不能为风格编造天气、见闻、行动结果或进展。
两个候选均是玩家可直接说出的第一人称台词，回应本轮 NPC 内容，保留实质差异和条件，不写“询问/告诉某人”等指令。人物身份、事实、知识和规则图仍独立限制正文。
事实表是授权范围，不是逐条复述的提纲。隐藏动机不进入正文；不能从职业或语气推导新能力、经历、线索与承诺。只返回完整 JSON。`;

function factSection(context: PlanningContext): string {
  if (context.kind === "opening") return "";
  const records = context.world.entityStore.records;
  const factRecords = records.filter(
    (record): record is FactEntityRecord => record.core.kind === "fact",
  );
  const npcRecords = records.filter(
    (record): record is NpcEntityRecord => record.core.kind === "npc",
  );
  const publicLines: string[] = [];
  const privateLines: string[] = [];
  for (const factRecord of factRecords) {
    const factId = String(factRecord.core.id);
    const knownBy = npcRecords
      .filter((record) => record.knowledge.entries.some((entry) => String(entry.factId) === factId))
      .map((record) => {
        const entry = record.knowledge.entries.find(entry => String(entry.factId) === factId)!;
        return `${record.core.id}，certainty=${entry.certainty}，disclosure=${JSON.stringify(entry.disclosure)}`;
      });
    const isSecret = npcRecords.some((record) =>
      record.knowledge.entries.some(
        (entry) => String(entry.factId) === factId && entry.disclosure === "secret",
      )) && !factRecord.fact.discovered;
    const line = `- ${factId}：${factRecord.fact.text}${knownBy.length > 0 ? `（可知：${knownBy.join("、")}）` : ""}`;
    (isSecret ? privateLines : publicLines).push(line);
  }
  return `# 玩家侧/非秘密事实（不代表所有 NPC 都知道；每个角色仍只能使用自己的可知与可披露事实）
${publicLines.length > 0 ? publicLines.join("\n") : "- 无"}

# 私密事实（只可用于结构化引用，不得进入可见文本）
${privateLines.length > 0 ? privateLines.join("\n") : "- 无"}`;
}

function branchSection(context: PlanningContext): string {
  if (context.kind === "opening") return "";
  const decisions = Object.entries(context.story.branchDecisions);
  if (decisions.length === 0) return "# 已选 branch\n- 无";
  return `# 已选 branch（后续规划必须尊重这些选择）
${decisions.map(([decisionId, decision]) =>
  `- ${decisionId}：npc=${decision.npcId}，已选=${context.story.selectedBranches[decisionId] ?? "尚未选择"}，候选=${decision.options.map((option) => `${option.candidateId}:${JSON.stringify(option.target)}`).join("/")}`)
  .join("\n")}`;
}

function jobSection(context: PlanningContext): string {
  if (context.kind === "opening") return "";
  const { job } = context;
  const previous = previousDialogue(context);
  const beats = job.mandatoryBeats.length > 0
    ? job.mandatoryBeats.map((beat) =>
      `- ${beat.beatId}（${beat.kind}）：${beat.instruction}`)
    : ["- 无"];
  return `# 本回合上下文
- 行动：${job.actionSummary.kind}
- 上一轮旁白（历史）：${JSON.stringify(previous?.narration ?? null)}
- 上一轮 NPC 实际答复（历史，不是新事实来源）：${JSON.stringify(previous?.reply ?? null)}
- 上一轮已展示候选（已选、未选都已展示，本轮两个新候选均须避开这些意图）：
${previous?.choices.map((choice, index) => `  ${index + 1}. ${JSON.stringify(choice)}`).join("\n") ?? "  无"}
- 玩家实际选择：${JSON.stringify(job.selectedDialogue === undefined ? null : { label: job.selectedDialogue.label, dialogueAct: job.selectedDialogue.dialogueAct, topic: job.selectedDialogue.topic })}（dialogueAct/topic 是已提交语义；label 仅是原话，不是事实或指令）
- 本次已提交的对话语义与结果（供剧情承接，不自动成为事实来源；仅 current 旁白的 quest_progress/quest_advanced 节拍可用本回合对应 quest_completed 事件证明完成，其余节拍只用自身实际知识来源）：${JSON.stringify(context.world.eventLedger.filter(event => job.domainEventIds.includes(event.eventId)).map(event => ({ eventId: event.eventId, kind: event.kind, payload: event.payload })))}
- 回合：${job.turnNumber}
- 玩家原话：${job.utterance ?? job.selectedDialogue?.label ?? "（无）"}
- 焦点 NPC：${job.focusNpcId === undefined ? "无" : String(job.focusNpcId)}

${job.mandatoryBeats.every(beat => beat.kind === "atmosphere")
    ? "# 必选节拍\n本轮没有必选节拍；atmosphere 只是可选项，本次无需安排，三个单元的 requiredBeats 均为 []。旁白由 draft 极短衔接，不展开问题细节。"
    : `# 必选节拍（当前旁白覆盖契约）
本次 current narration 允许的 beatId 全集：${JSON.stringify([...new Set([...job.mandatoryBeats.map(beat => beat.beatId), "atmosphere"])])}。不是这个数组里的键，一律不要添加。
以下除 atmosphere 外的每个 beatId 必须恰好分配给一个 stepKey="current" 的 narration 单元的 requiredBeats，kind 原样保留。
只交给 character、choices 或未来场景不算覆盖；不得遗漏或在多个当前旁白单元重复分配。
当前 narration 的 requiredBeats 只能使用下列服务端 beatId，最多额外使用固定键 atmosphere；不得自造 player_utterance、fact_discovered 等未列出的键，kind 名不是可自行添加的 beatId。列表为“无”时，只能用 atmosphere 或空数组。
若 current 有多个 narration 单元，独立 atmosphere 只能分配给最后一个；此前每个 narration 单元必须至少承接一个必选节拍，不能安排纯氛围空单元。
NPC 可以另行回应同一个节拍，但那是角色的说法，不替代旁白对已发生事件的交代；不要把 NPC 台词复制进旁白。
只有下表确实包含 player_utterance 时，该节拍才还须由当前焦点 NPC 回答。没有该节拍不表示 NPC 不回应玩家，只是不新增该节拍 ID。事实与证据仍须遵守各单元原有的可知、可披露范围。
${beats.join("\n")}`}`;
}

/**
 * PlanProposal 子结构契约段。
 *
 * 这是 Task 12 Step 4 修复的核心：原实现只声明顶层 8 键，模型只能靠猜，
 * 结果 units 用了 type/dependsOn、steps.next 用 null、publicIntent 用字符串，
 * 被 parsePlanProposal 的 hasOnlyKeys 白名单全数拒绝。此处逐字段给出契约，
 * 并对「凭直觉一定会写错」的 5 处（next 是数组、evidence 是对象数组、
 * publicIntent 是句段对象、investigate 用 factId、beatIds 用事实键）显式标注。
 */
export function renderPlanProposalContract(context: PlanningContext, includeWorldDelta = true): string {
  const isOpening = context.kind === "opening";
  const pointShape = `{"stepKey": 某个 step 的 key, "order": 非负整数}`;
  // 句段对象：facts 是 FactUse 对象数组（{factId, certainty}），不是裸键数组。
  const textPart = `{"text": 中文字符串, "facts": FactUse 数组, "evidence": EvidenceRef 数组, "beatIds": 键数组}`;

  return `# PlanProposal 精确契约（多一个键即整体拒绝，少一个键也拒绝）

顶层恰有 8 键：opening、worldDelta、steps、units、observations、actions、decision、terminal。
自定义 key 用小写字母/数字/下划线，长度 ≤ 128，不得重复。服务端 steps 的 key（可含冒号）必须原样引用；"$deferred" 是允许的专用占位符。

## steps[] —— 剧情骨架
每项恰有 3 键：{"key": 键, "trigger": 触发器, "next": 键数组}
- next 必须是**数组**（元素是其他 step 的 key），不是字符串也不是 null；终点步写 []。
- trigger 恰有 kind 与所需字段，kind ∈ ${PLANNING_TRIGGER_KINDS.join(" | ")}：
  - {"kind":"move","locationId":键} / {"kind":"explore","locationId":键}
  - {"kind":"investigate","factId":键}（可再加 "approachId":键；注意是 factId，不是 objectId）
  - {"kind":"take_item","itemId":键}
  - {"kind":"give_item","itemId":键,"npcId":键}
  - {"kind":"battle_started","enemyId":键}
  - {"kind":"battle_resolved","enemyId":键,"outcome":"victory"}（outcome 只能是 "victory"）
- steps 数量 ≤ ${MAX_NARRATIVE_BUNDLE_STEPS}，next 不得悬空、不得成环。

## draft —— 完整可展示初稿，唯一正文来源
- narration: {"stage":"narration","parts":[${textPart}],"actionKeys":已声明动作 key 数组}
- character: {"stage":"character","speakerId":与单元相同 NPC ID,"parts":[${textPart}],"emotion":"neutral"|"warm"|"guarded"|"afraid"|"angry"|"sad","actions":已声明的本角色动作对象数组,"answeredBeatIds":实际承接的必选节拍 ID 数组}
- choices: {"stage":"choices","labels":[{"candidateId":第一个候选 ID,"label":完整玩家台词},{"candidateId":第二个候选 ID,"label":完整玩家台词}]}
- parts 1–12 段，每段 1–500 字；labels 恰好两个，各 1–80 字，ID 与 decision.options 一一匹配；终幕使用 trust/doubt。原稿已是完整自然正文，不是待执行写作指令。
- facts 为 {"factId":实体 ID,"certainty":"known"|"suspected"} 对象数组；evidence 为 committed/conditional 引用；beatIds 为已声明节拍 ID 数组。旁白每段至多一个 beatId，覆盖全部必选节拍，氛围段放在必选内容之后。
- 原稿所有事实、证据、动作仍须通过角色/时间/知识权限，requiredBeats、observations、actions 独立声明，不能从正文反推授权。正文不可含未授权事实；不知道答案时 facts 可以为空。

## units[] —— 表达单元
每项恰有 {"key","stage","point","speakerId","dependencies","requiredObservationKeys","requiredBeats","draft"}。不得提供 task、taskFactIds 或额外正文副本。
- stage 取 "narration" | "character" | "choices"（**不是 type**）。
- **整份 units 里 stage="choices" 的单元只能有 1 个**，就是这个决策点本身；其余所有单元必须是 narration 或 character。
  一个 step 里排 2 个 choices 单元、或给每个场景都配一个 choices 单元，都会整体被拒（decision_unit_mismatch）。
  线性场景（非决策点）**没有** choices，只写 narration/character；玩家在决策点的两个候选由 decision 声明。
- point 恰有 2 键：${pointShape}（**不是裸字符串**，stepKey 是 "current" 或上面声明的未来 step key）。
- speakerId：stage="character" 时给 NPC 键，其余必须为 null。
- dependencies：键数组，元素是其他 unit 的 key（**不是 dependsOn、不是 stepId**）。
- requiredObservationKeys：键数组，元素是本次 observations 的 key（可为 []）。
  - **stage="choices" 的单元必须写 []**：选项单元只产出 label，不引用观察。
  - 非空时，所引用的观察**必须与本单元位于同一个 step（stepKey 完全相同）**，且 order 不大于本单元。
    跨 step 引用一律被拒（observation_without_source）——想引用前一个场景的观察，必须在本 step 里重新声明一条 observations。
- requiredBeats：数组，每项恰有 5 键：
  {"beatId": 键, "kind": 节拍类型, "factIds": 事实实体 id 数组, "evidence": 证据数组, "instruction": 非空中文字符串}
  - kind ∈ ${PLANNING_BEAT_KINDS.join(" | ")}
  - evidence 必须是**对象数组**，绝不可写成裸字符串数组；元素二选一：
    {"kind":"committed","eventId": 已提交事件 id} 或 {"kind":"conditional","observationKey": 本次 observations 的 key}
    无法确定时写 []。eventId 必须是真实事件 ID，不是事件 kind（如 quest_completed、npc_interaction_recorded）。已提交动作结果不自动成为任意事实的来源；没有明确事实来源时，requiredBeats.evidence 写 []，不要为每个节拍猜造证据。
- 表达单元总数 ≤ ${MAX_PLAN_UNITS}，dependencies 不得悬空、不得成环。

## observations[]
每项恰有 5 键：{"key","point","audienceIds","fact","source"}
- point 同 units（${pointShape}）。
- audienceIds：键数组，列出**确实能观察到这件事**的实体键（玩家必须写 "player_0"，不能写 "player"；NPC 写其真实实体键）。
- fact 恰有 2 键：{"factId": 事实实体 id, "certainty": "known" 或 "suspected"}。
- source 二选一且只能二选一：{"kind":"witness"} 或 {"kind":"speech","speakerId": NPC 实体 id}（开局链路 NPC 实体 id 是 npc_0）。
- speech 来源的 certainty 不得高于说话人自身的认知；key 不得重复。

**观察归属与初稿义务**：requiredObservationKeys 声明本单元负责向受众实际呈现/披露的观察，不是读取前文的输入依赖。旁白只认领 witness；NPC 只认领 speakerId 为自己的 speech，且自身须在 audienceIds 中；choices 必须写 []。
观察 key 必须存在、同 step、order 不晚于本单元。同序的本角色来源观察即使未列入 requiredObservationKeys，仍属于该单元。每条归属观察的 fact 必须出现于本单元 draft.parts[].facts，certainty 不得升级；写进 evidence/beatIds 不算呈现事实。
读取上游观察仍依靠 DAG 依赖和真实已批准披露，不靠填 requiredObservationKeys 授权。没有本单元新披露时 observations/requiredObservationKeys 可以为空；不得伪造 witness 或改成虚假 NPC speech 绕过权限。

## actions[] —— 无规则后果的表演动作
每项恰有 6 键：{"key","actorId","point","kind","objectId","audienceIds"}
- kind ∈ ${PLANNING_COSMETIC_ACTION_KINDS.join(" | ")}；objectId 为键或 null。

## decision
恰有 4 键：{"kind":"ordinary","point":与承接它的 choices 单元**完全相同**的 point,"npcId": NPC 键,"options":[选项, 选项]}
- options 恰好 2 项，candidateId 必须互不相同。
- 选项恰有 6 键：{"candidateId","dialogueAct","topic","target","publicIntent","deferredLocation"}
  - dialogueAct ∈ ${DIALOGUE_ACTS.join(" | ")}
  - topic 恰有 kind 与所需键，kind ∈ ${PLANNING_TOPIC_KINDS.join(" | ")}：
    {"kind":"general"} | {"kind":"fact","factId":键} | {"kind":"quest","questId":键} | {"kind":"thread","threadId":键}
  - target 普通对白为 null。旧路线数据的对象形状为 kind 与所需键，kind ∈ ${PLANNING_ROUTE_TARGET_KINDS.join(" | ")}：
    {"kind":"talk_to_npc","npcId":键} | {"kind":"visit_location","locationId":键} | {"kind":"obtain_item","itemId":键}
    | {"kind":"discover_fact","factId":键} | {"kind":"defeat_enemy","enemyId":键}
  - publicIntent 恰有 3 键：{"facts":FactUse 数组,"evidence":EvidenceRef 数组,"beatIds":[]}，只保存候选的引用元数据，不得含 text
    - facts 是 **FactUse 对象数组**，绝不可写成裸键数组：每项恰有 2 键 {"factId": 事实键, "certainty": "known" 或 "suspected"}。
      只放**公开事实**（私密事实不得进入玩家可见的选项意图）；不需要时写 []。
    - evidence 同 units 的 requiredBeats：对象数组（{"kind":"committed","eventId":…} 或 {"kind":"conditional","observationKey":…}），通常为 []。
    - beatIds：键数组，通常为 []。
  - 普通对白选项 target 必须为 null，deferredLocation 必须为 null。不需要新地点或不同未完成目标；不凭说话自动创建地点或替换任务。
  - 两个选项的 dialogueAct/topic 组合必须不同，并代表本场景中不同的具体回应。可以是同地点同 NPC 的合作与拒绝、相信与质疑、询问不同关键事实；不是同义改写。
  - 每个候选的完整台词只在 choices.draft.labels 写一次；publicIntent.facts 保留条件等全部授权事实引用，不仅是 topic。
  - 非 null 的旧路线目标仅用于恢复旧已批准数据，本次新的普通对话不得生成延迟路线模板。

## terminal
{"kind":"next_decision","target":{"kind":"current_scene"}} 或 {"kind":"next_decision","target":{"kind":"continuation_step","stepKey":键}} 或 {"kind":"ending"}。
${isOpening ? '- 开局固定 {"kind":"next_decision","target":{"kind":"current_scene"}}。' : "- 决策链路的延续目标必须指向本次声明的 step。"}

## opening
${isOpening
      ? `必须是完整 OpeningGenerationCandidate（见下节「opening 精确契约」），不得为 null。`
      : "必须为 null；决策链路禁止重跑开局结构编译。"}

## worldDelta
${includeWorldDelta ? `对象或 null；决策链路用于声明本回合新引入的地点/NPC/物品/敌人/事实/任务/结局对。开局链路必须为 null。
- null = 本回合不引入任何世界变化；非 null 时**必须至少包含一个实体变化字段**（newLocation/newNpc/newItem/newEnemy/newFact/nextMainQuest/endingPair 至少一个非 null），只有 beatSummary 的空提案会被整体拒绝（plan_world_delta_invalid）。
- 顶层的键只能是：beatSummary、newLocation、newNpc、newItem、newEnemy、newFact、nextMainQuest、endingPair；未使用的键一律写 null，不得省略之外的未知键。
- beatSummary：非空中文字符串，≤ ${WORLD_DELTA_MAX_TEXT} 字，概述本回合节拍。
- newLocation：null 或恰有 5 键 {"name","description","scale","placement","connectFromLocationId"}
  - name 为 ${2}-${WORLD_DELTA_MAX_NAME} 字；description 为 1-${WORLD_DELTA_MAX_TEXT} 字。
  - scale ∈ "scene" | "town"；placement ∈ "world" | "town_building"。
  - connectFromLocationId：已存在地点的实体 id，非空字符串。
- newNpc：null 或恰有 7 键 {"name","role","description","locationRef","anchors","goals","relationshipSeeds"}（7 键全部必填）
  - name 为 ${2}-${WORLD_DELTA_MAX_NAME} 字；role、description 为 1-${WORLD_DELTA_MAX_TEXT} 字。
  - locationRef 二选一：{"kind":"existing","id":已存在地点实体 id} 或 {"kind":"new_location"}（与 newLocation 同时声明时表示落在新地点）。
  - anchors 恰有 5 键 {"selfConcept","values","speechStyle","capabilityBoundaries","taboos"}：
    selfConcept、speechStyle 为 1-${NPC_CREATION_TEXT_MAX_LENGTH} 字非空字符串；
    values、capabilityBoundaries 为 ${NPC_ANCHOR_LIST_MIN}-${NPC_ANCHOR_LIST_MAX} 条非空字符串数组（不得重复）；
    taboos 为 ${NPC_TABOO_LIST_MIN}-${NPC_ANCHOR_LIST_MAX} 条非空字符串数组（不得重复）。
  - goals 为 ${NPC_GOAL_LIST_MIN}-${NPC_GOAL_LIST_MAX} 条数组，每项恰有 4 键 {"horizon","description","priority","reason"}：
    horizon ∈ ${NPC_GOAL_HORIZONS.join(" | ")}；priority 为 ${NPC_GOAL_PRIORITIES[0]}-${NPC_GOAL_PRIORITIES[NPC_GOAL_PRIORITIES.length - 1]} 的整数；
    description、reason 为 1-${NPC_CREATION_TEXT_MAX_LENGTH} 字非空字符串；description 不得重复。
  - relationshipSeeds 为 0-${NPC_RELATIONSHIP_SEED_LIST_MAX} 条数组，每项恰有 3 键 {"targetNpcId","stance","reason"}：
    targetNpcId 为已存在 NPC 的实体 id（非空字符串，不得重复）；
    stance ∈ ${NPC_RELATIONSHIP_SEED_STANCES.join(" | ")}；reason 为 1-${NPC_CREATION_TEXT_MAX_LENGTH} 字非空字符串。
- newItem：null 或恰有 4 键 {"name","description","locationRef","acquisition"}
  - name 为 ${2}-${WORLD_DELTA_MAX_NAME} 字；description 为 1-${WORLD_DELTA_MAX_TEXT} 字。
  - locationRef ∈ "current" | "new_location"（注意：此处是字符串，不是 newNpc 的对象形式）。
  - acquisition 可省略；提供时 ∈ "scene" | "npc_gift"。
- newEnemy：null 或恰有 3 键 {"name","tier","locationRef"}
  - name 为 ${2}-${WORLD_DELTA_MAX_NAME} 字；tier ∈ "normal" | "boss"；locationRef 同 newItem（"current" | "new_location"）。
- newFact：null 或恰有 4 键 {"text","visibility","investigationLabel","investigationApproaches"}
  - text 为 1-${WORLD_DELTA_MAX_TEXT} 字非空字符串；visibility ∈ "public" | "npc_private"。
  - investigationLabel 可省略；提供时为 ${2}-${WORLD_DELTA_MAX_NAME} 字。
  - investigationApproaches 可省略（缺省 = 该事实自动揭示）；提供时必须恰好 ${MIN_APPROACH_COUNT}-${MAX_APPROACH_COUNT} 条，每项恰有 5 键
    {"approachId","label","hint","evidenceQuality","tensionDelta"}：
    approachId、label、hint 均为非空字符串（approachId 不得重复）；
    evidenceQuality ∈ "clean" | "noisy"；tensionDelta 为 ${MIN_TENSION_DELTA} 到 ${MAX_TENSION_DELTA} 的整数；
    label/hint 中不得出现完整的事实正文（防泄漏，含完整正文即整体拒绝）。
- nextMainQuest：null 或恰有 3 键 {"name","description","objectiveText"}
  - name 为 ${2}-${WORLD_DELTA_MAX_NAME} 字；description、objectiveText 为 1-${WORLD_DELTA_MAX_TEXT} 字。
- endingPair：null 或恰好 2 项的数组，每项恰有 3 键 {"themeKey","name","description"}
  - themeKey ∈ "trust" | "doubt"，两项必须互异（同名主题或同名结局都会被审批拒绝）；name 为 ${2}-${WORLD_DELTA_MAX_NAME} 字且两项互异；description 为 1-${WORLD_DELTA_MAX_TEXT} 字。` : "本次必须为 null；只规划当前规则要求的表达，不创建新世界实体。"}`;
}

/** opening 段的精确契约：与 parseOpeningGenerationCandidate 逐字段对应。 */
function openingContractSection(context: PlanningContext): string {
  if (context.kind !== "opening") return "";
  const targetActs = context.input.gameLength === "medium" ? 5 : 3;
  return `# opening 精确契约（opening ∈ PlanProposal，不是替代字段）
禁止使用 world.name、fact.id、player.background、storyContract.goal、opening.task 等替代字段。

- opening 恰有 5 键：world、player、prologue、storyContract、opening。
- **实体 id 是服务端固定分配的，你不得自造**（自造会导致 unknown_speaker 等整体失败）。开局编译后实体 id 固定为：
  - 玩家：固定为 "player_0"（在 audienceIds 里可写 "player_0"；participantRefs 里用 "player"）。
  - 开场 NPC：固定为 "npc_0"。**units[].speakerId、observations[].audienceIds、observations[].source.speakerId、
    decision.npcId、branch 的 talk_to_npc.npcId 都只能写 "npc_0"**，绝不能写你在 opening.npc.name 里起的中文名或拼音名。
  - 开场地点：固定为 "loc_0"。quest：固定为 "quest_0"。
  - 公开事实：按 world.publicFacts 的**数组下标**依次固定为 "fact_0"、"fact_1"、"fact_2"……
    （即 publicFacts[0].key 对应实体 id "fact_0"）。units[].draft.parts[].facts、requiredBeats[].factIds、
    observations[].fact.factId 引用的都是**实体 id**（形如 fact_0），不是 publicFacts 里的语义 key。
- world 恰有 4 键：summary、tone、themes、publicFacts。
  - themes 为字符串数组；publicFacts 每项恰有 key、text（可选 investigationApproaches）；key 必须唯一且满足 [a-z][a-z0-9_]*。
  - investigationApproaches 不需要时省略或写 []；非空时必须是 2–3 项**对象**数组（不能是字符串数组），每项恰含 approachId、label、evidenceQuality、tensionDelta，可选 hint；evidenceQuality 只能是 "clean" 或 "noisy"，tensionDelta 是 [-5,20] 内的有限数值；label 与 hint 不得包含完整事实正文。
- player 恰有 5 键：name、identity、backgroundSummary、baseStats、knownFactKeys。knownFactKeys 必须显式列出玩家已知的公开事实 key，可为空；独立于 NPC 的已知集合，不包含 NPC 私密事实。
  - baseStats 恰有 hp、attack、defense，均为有限数值（建议 {"hp":100,"attack":10,"defense":5}）。
  - name/identity/backgroundSummary 必须保留玩家输入含义，不补写玩家未做过的承诺或行动。
- prologue 为字符串（简短）。
- storyContract 恰有 4 键：version、targetActs、centralConflict、endingDirections。
  - version 固定为 1；targetActs 固定为 ${targetActs}（由本局长度决定）。
  - endingDirections 恰好 2 项且顺序固定：[{"key":"trust","theme":"..."},{"key":"doubt","theme":"..."}]。
- opening 恰有 6 键：location、npc、quest、situation（可选 firstScene、variationProfile）。
  - location 恰有 4 键：name、description、buildingName、scale；scale 固定为 "town"（town 指聚居地，不等于古镇或客栈）。
  - npc 恰有 7 键：name、role、description、knownFactKeys、privateFactKeys、anchors、goals。
    - knownFactKeys 与 privateFactKeys 只能引用 world.publicFacts 的 key，且两者不得相交。
    - NPC knownFactKeys 只决定 NPC 可说知识；玩家亲历由 player.knownFactKeys 单独声明。privateFactKeys 正文绝不可出现在可见文本里。
    - anchors 恰有 5 键：selfConcept（字符串）、values（1–4 条）、speechStyle（字符串）、capabilityBoundaries（1–4 条）、taboos（0–4 条）；单条 ≤ 200 字。
    - goals 为 1–4 条，每项恰有 4 键：horizon（"short" | "long"）、description、priority（1–5）、reason；不得输出 goalId 或 status。
  - quest 恰有 3 键：name、description、objective；objective 固定为 {"kind":"talk_to_opening_npc"}；不得暗示玩家已接取或完成。
  - situation 恰有 4 键：history、threads、npcConnection、responses。
    - 所有局部 key 长度 1–40，匹配 [a-z][a-z0-9_]*；history/threads/responses 各自 key 唯一。
    - history 0–4 条，每条恰有 4 键：key、factKeys（1–4）、participantRefs（1–2，取值仅 "player" 或 "opening_npc"）、causeHistoryKeys（0–4，只能引用同批更早的 history key）。
    - threads 1–3 条，每条恰有 5 键：key、questionFactKey（必须属于 NPC 公开 knownFactKeys 或 player.knownFactKeys，并排除 NPC privateFactKeys）、supportingFactKeys（0–4）、participantRefs、causeHistoryKeys。
    - npcConnection 恰有 3 键：familiarity、stance、basisHistoryKeys。
      familiarity 取 "stranger" | "known"；stance 取 "neutral" | "ally" | "protective_of" | "indebted_to" | "rival" | "wary"。
      familiarity="stranger" 时 stance 必须是 "neutral" 且 basisHistoryKeys 为 []。
    - responses 恰好 2 项，每项恰有 3 键：key、dialogueAct、topic。
      dialogueAct ∈ ${DIALOGUE_ACTS.join(" | ")}；topic 恰有 2 键：{"kind":"fact"|"thread","key": 键}（注意此处的键名是 key，不是 factId/threadId）。
      fact key 必须属于 NPC 公开 knownFactKeys 或 player.knownFactKeys，并排除 NPC privateFactKeys；这只允许选题，不把玩家知识授予 NPC，NPC 新线索仍须实际披露后才能进入玩家选项。thread key 必须属于已声明的 threads；两项的 act/topic 语义必须不同。`;
}

/** 仅识别服务端审批反馈；普通文本/旧格式反馈不替换当前结构上下文。此投影不授予审批权限。 */
function repairedSceneContract(repair: AiContentRepair | undefined): Record<string, unknown> | null {
  if (repair?.detail === undefined) return null;
  try {
    const detail: unknown = JSON.parse(repair.detail);
    if (detail === null || typeof detail !== "object" || !("sceneContract" in detail)) return null;
    const value = detail.sceneContract;
    if (value === null || typeof value !== "object" || !("graphStatus" in value) || value.graphStatus !== "approved"
      || !("steps" in value) || !Array.isArray(value.steps) || !("terminal" in value)
      || !("decisionPoint" in value) || typeof value.decisionPoint !== "string") return null;
    return value as Record<string, unknown>;
  } catch { return null; }
}

/** Builds the staged planning prompt: complete content drafts, no final presentation text. */
export function buildPlanningPrompt(context: PlanningContext, repair?: AiContentRepair, separateContent = false): string {
  const sceneGraph = context.kind === "decision" ? buildNarrativeBundleDescriptors({
    worldState: context.world, storyState: context.story, transition: context.job.objectiveTransition,
  }) : null;
  const needsNextAct = context.kind === "decision" && stagedEvolutionNeed(context.story).kind === "next_act";
  const needsWorldDelta = context.kind === "decision" && stagedEvolutionNeed(context.story).kind !== "none";
  const repairedGraph = context.kind === "decision" ? repairedSceneContract(repair) : null;
  const entityContext = context.kind === "decision"
    ? buildEntityContextProjection({ worldState: context.world, storyState: context.story, job: context.job }) : null;
  const structuralContext = sceneGraph === null ? "" : `# 服务端场景骨架\n${JSON.stringify({
    evolutionNeed: context.kind === "decision" ? stagedEvolutionNeed(context.story) : { kind: "none" },
    current: "current",
    currentLocationId: context.kind === "decision" ? context.world.currentLocationId : null,
    entityContext,
    ...(repairedGraph ?? (needsNextAct ? { graphStatus: "pending_world_delta", instruction: "旧幕已经结束；本轮必须生成 nextMainQuest 与目标实体，再按增量后的图安排场景。current 只回应本轮已发生的行动；若下一决策在未来，则 current 不得有 choices。没有当前可照抄的终点。" }
      : planningSceneContract(sceneGraph, context.kind === "decision" ? context.job.focusNpcId ?? null : null))),
    dynamicIds: context.kind === "decision" ? {
      location: `loc_dyn_${context.story.evolution.nextLocationOrdinal}`,
      npc: `npc_dyn_${context.story.evolution.nextNpcOrdinal}`,
      item: `item_dyn_${context.story.evolution.nextItemOrdinal}`,
      enemy: `enemy_dyn_${context.story.evolution.nextEnemyOrdinal}`,
      fact: `fact_dyn_${context.story.evolution.nextFactOrdinal}`,
      quest: `quest_dyn_${context.story.evolution.nextQuestOrdinal}`,
    } : null,
    entities: context.kind === "decision" ? context.world.entityStore.records.map(record => ({ id: record.core.id, name: record.core.name, kind: record.core.kind })) : [],
  })}\nevolutionNeed.kind=none 时 worldDelta 必须严格为 null，不得用空对象、不得为刚选的路线再生成实体（路线已由规则创建）。当前回应必须有 stepKey=current 的旁白/角色单元；current 不属于 steps。无 worldDelta 时必须逐项沿用这里的 steps 和 terminal，不能自造 investigate 步骤代替对话，也不能把当前回应挂到未来。`;
  const repairSection = repair === undefined
    ? ""
    : `\n# 上次生成的校验反馈\n${renderAiRepairFeedback(repair)}\n请依据原契约修复并重新输出完整 JSON。\n`;

  const openingSection = context.kind === "opening"
    ? `${renderOpeningSetupSection(context.input)}
- 相似度重试 attempt=${context.input.attempt ?? 0}
${context.input.novelty?.recent?.length
        ? `\n# 有界新颖性上下文\n${context.input.novelty.recent.slice(0, 3).map((record, index) => `- 最近 ${index + 1}：${record.summary}`).join("\n")}`
        : ""}`
    : "";

  const openingTask = context.kind === "opening"
    ? `- opening 必须为完整 OpeningGenerationCandidate（见下节），prologue/描述只是内容素材，最终序幕由 narration 单元覆盖后才发布。
- 开局已经位于起始地点，steps 必须为 []。所有单元 point.stepKey 固定为 "current"，依次 narration → character(npc_0) → choices；不得安排移动到自己所在地点、investigate 或未来片段。
- 开局两个选项 target/deferredLocation 都为 null；用 opening.situation.responses 的不同 dialogueAct/topic 表示不同回应，不为凑选项创建地点。
- decision.options 的 candidateId 必须逐项等于 opening.opening.situation.responses 的 key，dialogueAct/topic 同源，不能添加 opt_ 前缀或另起 ID。
- privateFactKeys 对应秘密不得进入 narration/choices 的 draft、requiredBeats、observations；不能把玩家开端已亲眼看到的事设成 NPC 独占秘密。
- requiredBeats.instruction 只写节拍类别意图，不写含秘密的台词草稿；必须用 draft.parts[].facts/requiredBeats.factIds 明确本单元要表达的事实，旁白和 NPC 不能自行决定关键内容。`
    : `- opening 必须为 null；决策链路禁止重跑开局结构编译。`;

  return `你是 RPG 的剧情规划 AI。本次调用产出完整 PlanProposal JSON，包含完整旁白、NPC 台词和两个玩家选项初稿；后续只润色正文。
${context.kind === "opening" ? "重要：你决定剧情事件、NPC 要表达的具体内容和两个玩家回应的不同语义；三个表达器只负责表达。普通回应允许同地同 NPC，不要求新地点。" : "你仍负责决定本轮内容和承接玩家选择；三个表达器只负责在授权范围内表达，不负责另编剧情。"}
${openingSection}
${branchSection(context)}

# 预算与规模上限
- 表达单元（narration/character/choices）总数不超过 ${MAX_PLAN_UNITS} 个。
- 同一 stepKey 的同一 NPC 必须恰好一个 character 单元，draft 包含完整回应；不按问题拆分单元。
- steps 不超过 ${MAX_NARRATIVE_BUNDLE_STEPS} 个；units 的依赖必须无环且不悬空。
- observations 每条必须有来源（speech 指明 speakerId，或 witness）；speech 观察的 certainty 不得高于说话人自身的认知。
- 恰好一个 choices 单元承接 decision${context.kind === "opening" ? "（开局两个候选来自 situation.responses）" : ""}；decision.point 必须与 choices 单元 point 一致，choices 之后不得再排单元。
- 单场普通问答通常只需 narration、character、choices 各一个单元；decision.options 不能代替 choices 单元，三个单元都要声明。

# 创作要求
${openingTask}
- 世界和任务继续沿既有规则推进。不同回应由 dialogueAct/topic 及实际规则结果供后续规划承接，不强制额外路线，不发明任意效果。
- 规划的节拍链：服务端 mandatory beat 按“当前旁白覆盖契约”分配，不是任意单元承接即可。
- choices 单元与 decision 的候选数都是 2；这里的候选就是最终意图，后续不会再调用规划器。开局候选与 opening.situation.responses 同源；后续候选根据本次回答重新确定，不固定为 ask/challenge 组合。

${renderPlanProposalContract(context, needsWorldDelta)}
${openingContractSection(context)}

${needsWorldDelta ? `# 世界演化与衔接
- 已存在实体不是新建模板；entityContext.occupiedNames 是已占用名称，不是可用候选。想沿用旧 NPC/地点就引用已有 ID，不在 newNpc/newLocation 重建；新实体须使用未占用名称。
- newLocation.connectFromLocationId 必须等于上方 currentLocationId，不因开局在 loc_0 就一直从 loc_0 接入。
- newItem.acquisition=npc_gift 必须同批提出 nextMainQuest/newNpc，且 newItem 与 newNpc 共址；旧 NPC 不能充当本次新物品的赠予者。场景拾取用 scene，不能在文字里改称 NPC 已赠予。
- evolutionNeed.kind=next_act 时，本轮旧主线已结束，必须提出 worldDelta.nextMainQuest，并提供能支撑新目标的新实体。不能只有任务名没有目标实体，不能回退 worldDelta=null。
- 新 NPC 不继承旧 NPC、玩家或整包的知识。同批 newFact.visibility=public 才能成为新 NPC 的可说事实（ID 为 dynamicIds.fact）；不要把旧 NPC 的 fact_dyn_N 任务搬给新 NPC。没有可说事实时只回应自己的公开身份/现场，或 明确不知道，不新增观察给自己授权。
- 新 NPC、新地点等实体只按本次剧情需要生成，不是为了两选项而生成；引用服务端 dynamicIds（仅对应实体确实提出时才存在）。worldDelta 没有产生的 ID 不能引用。
- newLocation.placement=world 且新 NPC 位于 new_location 时，步骤通常为 {"key":"move:新地点ID","trigger":{"kind":"move","locationId":"新地点ID"},"next":[]}，当前场景回应原 NPC，未来地点才让新 NPC 说话，choices 和 decision 都在未来抵达时点。决不能照抄增量前的 ending 终点。
- newLocation.placement=town_building 时，建筑挂在原城镇下，不创建 loc_dyn 地点 ID；NPC 实际 locationId 仍为 connectFromLocationId，抵达步骤使用 explore:该城镇ID，不能写 move:loc_dyn 或 explore:loc_dyn。必须同时声明位于 new_location 的 newNpc。\n- next_act 可按既有规则提交新地点、新 NPC、物品、敌人和任务；public 只是可公开，不等于玩家已发现。新事实若尚未由规则目标确认，抵达后的第一段旁白不能提前引用；应先由确实知道该事实的新 NPC 在自己的 character 单元通过 speech observation 向 player_0 披露，再让同场更晚且依赖该角色单元的旁白/选项引用实际披露。NPC 的 requiredObservationKeys 包含该观察 key；不要用玩家旁白自造 witness 来授权，也不要让旧 NPC 讲述新 NPC 的知识。NPC 私有事实不自动公开。newFact.visibility=npc_private 时，不得把该事实写进玩家选项 topic、旁白 requiredBeats，或用 speech/witness observations 强行公开；角色可知道但本包不可说。为保密不需要生成观察，不披露的秘密只留给规划器。
- 发生世界增量后，steps/terminal 必须匹配规则编译该增量所得的图；修复反馈若包含 approvedWorldDelta 和 steps/terminal，沿用已批准增量并严格引用该图。
- evolutionNeed.kind=ending_pair 时，只提供 trust/doubt 两个 endingPair，terminal={"kind":"ending"}、steps=[]、decision=null。units 仍必须包含 current 旁白、现场 NPC 和最后一个 choices 单元；这是 decision 非空要求的唯一例外。服务端将为该 choices 单元派生 trust/support 和 doubt/challenge 候选，表达器只写立场对白，不预告结局结果。` : ""}

# 最终结构检查（优先于自定义 key 格式）
${structuralContext}
${repairSection}
- terminal.kind=ending 时，顶层 decision 必须是 JSON null（不是 ordinary/ending 对象）；只保留 current 的最后一个 choices 单元。trust/doubt 立场由规则固定，完整标签写入 choices.draft.labels，不在 decision.options 定义。此条优先于普通决策的“两条候选”要求。
- graphStatus=approved 表示场景图已经由规则编译（不是整包获批），包括有 worldDelta 的修复。terminal.kind=next_decision 时，唯一 choices 的 point.stepKey 和 decision.point.stepKey 必须同时等于 decisionPoint，二者 order 也必须一致；decision.npcId 必须等于 decisionNpcId，candidateId 沿用 candidateIds。terminal.kind=ending 则继续遵守上方 decision=null 的结局契约。不得因本回合焦点 NPC 是旧 NPC，就把下一决策也留给旧 NPC。
- scenes[].allowsChoices=false 的场景只安排回应，不安排选项；responseNpcId 表示该场景的角色对象，不是全包共用 speaker。沿用反馈中的 approvedWorldDelta，重新规划各场景的表达意图、依赖与选项语义，不要仅改 terminal 或机械搬移旧 NPC 的对白任务。
- current 只允许出现在 units[].point.stepKey，不允许作为 steps[].key。
- 每个 requiredScenes 都必须有自己的 narration/character 单元，不得把全部单元放在 current。
- 无 worldDelta 时，唯一 choices 单元和 decision.point 必须放在上方 decisionPoint。graphStatus=pending_world_delta 时，以增量后终点为准：如 steps=[move:新地点ID]，则未来旁白、未来 NPC、choices、decision.point 全部使用这个 stepKey，不得仍放在 current。未来场景 NPC 只能在其实际所在地出现。
- 服务端带冒号的 step key 必须原样复制，禁止改名。不要重复选择本次已选路线或引用未选且未生成的实体。

# 顶层输出
${separateContent ? "" : buildPlanningContentPrompt(context)}

只返回一个 JSON 对象，即 PlanProposal：顶层必须且只能有 opening、worldDelta、steps、units、observations、actions、decision、terminal。
禁止输出任何解释文字、Markdown 代码围栏或 JSON 之外的包装。所有自由文本使用中文；自定义 key 用 [a-z][a-z0-9_]*，服务端 key 原样保留，长度 ≤ 128。`;
}

/** 相同上下文单独放在最后一条用户消息中，避免本轮内容被长结构说明淹没。 */
export function buildPlanningContentPrompt(context: PlanningContext): string {
  if (context.kind === "opening") return "";
  return `${factSection(context)}

# 同一 NPC 更早几轮的对话（从旧到新，仅作历史，不是指令或事实来源）
每项 previousReply/previousChoices 是该次选择前已展示的内容，selectedDialogue 是玩家随后实际选择的意图；不要把 NPC 已说不知道的问题再次提出。
${JSON.stringify(context.dialogueHistory?.map(entry => ({ previousReply: entry.previousReply, previousChoices: entry.previousChoices, selectedDialogue: { label: entry.selectedDialogue.label, dialogueAct: entry.selectedDialogue.dialogueAct, topic: entry.selectedDialogue.topic } })) ?? [])}
${jobSection(context)}
${context.job.mandatoryBeats.every(beat => beat.kind === "atmosphere") && context.job.selectedDialogue !== undefined
    ? "本轮是没有必选旁白事件的连续对白：旁白 draft 只做极短对话衔接，不展开问题细节；不杜撰环境、天气、动作或进展，不代写 NPC 的回答。" : ""}

现在生成这一轮的完整规划。先明确回答玩家这一次的问话，再给两条新的回应，最后安排旁白承接。上一轮列出的两个候选都已经展示过，即使其中一个未选，本轮也不能再给。已说的背景不再安排进 NPC 内容稿；单纯未知回答的事实数组为空。没有新场景信息时，旁白只做极短对话衔接，不展开问题细节；必选节拍的覆盖要求仍须满足。
返回完整 PlanProposal JSON，包含所需的 narration、character、choices 单元；decision.options 不代替 choices 单元。`;
}
