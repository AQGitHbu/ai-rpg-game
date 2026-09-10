// staged planning prompt（Spec 2026-09-09 / Plan Task 5 Step 3，Task 12 Step 4 补全契约）。
//
// planning 只产骨架：PlanProposal 不含最终展示文本。prompt 携带预算上限、
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
import { MAX_LABEL_LENGTH, MAX_TEXT_PART_LENGTH } from "@/game/domain/narrativeUnit";
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
      .map((record) => String(record.core.id));
    const isSecret = npcRecords.some((record) =>
      record.knowledge.entries.some(
        (entry) => String(entry.factId) === factId && entry.disclosure === "secret",
      )) && !factRecord.fact.discovered;
    const line = `- ${factId}：${factRecord.fact.text}${knownBy.length > 0 ? `（可知：${knownBy.join("、")}）` : ""}`;
    (isSecret ? privateLines : publicLines).push(line);
  }
  return `# 公开事实（可进入可见文本）
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
  `- ${decisionId}：npc=${decision.npcId}，候选=${decision.options.map((option) => option.candidateId).join("/")}`)
  .join("\n")}`;
}

function jobSection(context: PlanningContext): string {
  if (context.kind === "opening") return "";
  const { job } = context;
  const beats = job.mandatoryBeats.length > 0
    ? job.mandatoryBeats.map((beat) =>
      `- ${beat.beatId}（${beat.kind}）：${beat.instruction}`)
    : ["- 无"];
  return `# 本回合上下文
- 行动：${job.actionSummary.kind}
- 回合：${job.turnNumber}
- 玩家原话：${job.utterance ?? "（无）"}
- 焦点 NPC：${job.focusNpcId === undefined ? "无" : String(job.focusNpcId)}

# 必选节拍（每个 beatId 必须被某个单元的 requiredBeats 承接）
${beats.join("\n")}`;
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
export function renderPlanProposalContract(context: PlanningContext): string {
  const isOpening = context.kind === "opening";
  const pointShape = `{"stepKey": 某个 step 的 key, "order": 非负整数}`;
  // 句段对象：facts 是 FactUse 对象数组（{factId, certainty}），不是裸键数组。
  const textPart = `{"text": 中文字符串, "facts": FactUse 数组, "evidence": EvidenceRef 数组, "beatIds": 键数组}`;

  return `# PlanProposal 精确契约（多一个键即整体拒绝，少一个键也拒绝）

顶层恰有 8 键：opening、worldDelta、steps、units、observations、actions、decision、terminal。
所有 key 满足 [a-z][a-z0-9_]*，长度 ≤ 128，不得重复。

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

## units[] —— 表达单元
每项恰有 8 键：{"key","stage","point","speakerId","dependencies","taskFactIds","requiredObservationKeys","requiredBeats"}
- stage 取 "narration" | "character" | "choices"（**不是 type**）。
- **整份 units 里 stage="choices" 的单元只能有 1 个**，就是这个决策点本身；其余所有单元必须是 narration 或 character。
  一个 step 里排 2 个 choices 单元、或给每个场景都配一个 choices 单元，都会整体被拒（decision_unit_mismatch）。
  线性场景（非决策点）**没有** choices，只写 narration/character；玩家在决策点的两个候选由 decision 声明。
- point 恰有 2 键：${pointShape}（**不是裸字符串**，stepKey 必须是上面声明的 step key）。
- speakerId：stage="character" 时给 NPC 键，其余必须为 null。
- dependencies：键数组，元素是其他 unit 的 key（**不是 dependsOn、不是 stepId**）。
- taskFactIds：键数组，元素是本单元需要用到的事实**实体 id**（开局链路形如 fact_0，见 opening 节的实体 id 约定；decision 链路用公开/私密事实段列出的 id）。可为 []。
- requiredObservationKeys：键数组，元素是本次 observations 的 key（可为 []）。
  - **stage="choices" 的单元必须写 []**：选项单元只产出 label，不引用观察。
  - 非空时，所引用的观察**必须与本单元位于同一个 step（stepKey 完全相同）**，且 order 不大于本单元。
    跨 step 引用一律被拒（observation_without_source）——想引用前一个场景的观察，必须在本 step 里重新声明一条 observations。
- requiredBeats：数组，每项恰有 5 键：
  {"beatId": 键, "kind": 节拍类型, "factIds": 事实实体 id 数组, "evidence": 证据数组, "instruction": 非空中文字符串}
  - kind ∈ ${PLANNING_BEAT_KINDS.join(" | ")}
  - evidence 必须是**对象数组**，绝不可写成裸字符串数组；元素二选一：
    {"kind":"committed","eventId": 已提交事件 id} 或 {"kind":"conditional","observationKey": 本次 observations 的 key}
    无法确定时写 []。
- 表达单元总数 ≤ ${MAX_PLAN_UNITS}，dependencies 不得悬空、不得成环。

## observations[]
每项恰有 5 键：{"key","point","audienceIds","fact","source"}
- point 同 units（${pointShape}）。
- audienceIds：键数组，列出**确实能观察到这件事**的角色键（玩家写 "player"，NPC 写其键）。
- fact 恰有 2 键：{"factId": 事实实体 id, "certainty": "known" 或 "suspected"}。
- source 二选一且只能二选一：{"kind":"witness"} 或 {"kind":"speech","speakerId": NPC 实体 id}（开局链路 NPC 实体 id 是 npc_0）。
- speech 来源的 certainty 不得高于说话人自身的认知；key 不得重复。

**引用观察的硬性约束（最易错，务必逐条满足）**：单元通过 requiredObservationKeys 引用某条观察时，服务端要求**同时**成立：
1. 该 key 确实存在于 observations 里；
2. 该观察的 point.stepKey **与本单元 point.stepKey 完全相同**（**跨 step 引用必然失败**，这是最常见的错误）；
3. 该观察的 point.order **≤ 本单元 point.order**（观察必须发生在先）；
4. 若本单元 speakerId 不为 null，则该 speakerId **必须出现在该观察的 audienceIds 里**。

因此：写 character 单元时，它引用的每条观察的 audienceIds 都必须包含该单元的 speakerId；写任何非 choices 单元时，所引用的观察都必须与它在同一个 step。**stage="choices" 的单元 requiredObservationKeys 必须为空数组**。任一条件不成立即整体被拒（observation_without_source），planning 会直接失败。

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
  - target 恰有 kind 与所需键，kind ∈ ${PLANNING_ROUTE_TARGET_KINDS.join(" | ")}：
    {"kind":"talk_to_npc","npcId":键} | {"kind":"visit_location","locationId":键} | {"kind":"obtain_item","itemId":键}
    | {"kind":"discover_fact","factId":键} | {"kind":"defeat_enemy","enemyId":键}
  - publicIntent **不是字符串**，而是句段对象，恰有 4 键：${textPart}
    - text 必须简短（≤ ${MAX_TEXT_PART_LENGTH} 字）。
    - facts 是 **FactUse 对象数组**，绝不可写成裸键数组：每项恰有 2 键 {"factId": 事实键, "certainty": "known" 或 "suspected"}。
      只放**公开事实**（私密事实不得进入玩家可见的选项意图）；不需要时写 []。
    - evidence 同 units 的 requiredBeats：对象数组（{"kind":"committed","eventId":…} 或 {"kind":"conditional","observationKey":…}），通常为 []。
    - beatIds：键数组，通常为 []。
  - deferredLocation：通常为 null。

## terminal
{"kind":"next_decision","target":{"kind":"current_scene"}} 或 {"kind":"next_decision","target":{"kind":"continuation_step","stepKey":键}} 或 {"kind":"ending"}。
${isOpening ? '- 开局固定 {"kind":"next_decision","target":{"kind":"current_scene"}}。' : "- 决策链路的延续目标必须指向本次声明的 step。"}

## opening
${isOpening
      ? `必须是完整 OpeningGenerationCandidate（见下节「opening 精确契约」），不得为 null。`
      : "必须为 null；决策链路禁止重跑开局结构编译。"}

## worldDelta
对象或 null；决策链路用于声明本回合新引入的地点/NPC/物品/敌人/事实/任务/结局对。开局链路必须为 null。
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
  - themeKey ∈ "trust" | "doubt"，两项必须互异（同名主题或同名结局都会被审批拒绝）；name 为 ${2}-${WORLD_DELTA_MAX_NAME} 字且两项互异；description 为 1-${WORLD_DELTA_MAX_TEXT} 字。`;
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
    （即 publicFacts[0].key 对应实体 id "fact_0"）。units[].taskFactIds、requiredBeats[].factIds、
    observations[].fact.factId 引用的都是**实体 id**（形如 fact_0），不是 publicFacts 里的语义 key。
- world 恰有 4 键：summary、tone、themes、publicFacts。
  - themes 为字符串数组；publicFacts 每项恰有 key、text（可选 investigationApproaches）；key 必须唯一且满足 [a-z][a-z0-9_]*。
  - investigationApproaches 不需要时省略或写 []；非空时必须是 2–3 项**对象**数组（不能是字符串数组），每项恰含 approachId、label、evidenceQuality、tensionDelta，可选 hint；evidenceQuality 只能是 "clean" 或 "noisy"，tensionDelta 是 [-5,20] 内的有限数值；label 与 hint 不得包含完整事实正文。
- player 恰有 4 键：name、identity、backgroundSummary、baseStats。
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
    - knownFactKeys 是可用于首屏/台词/选项/公开 history 的事实；privateFactKeys 正文绝不可出现在 visible 文本里。
    - anchors 恰有 5 键：selfConcept（字符串）、values（1–4 条）、speechStyle（字符串）、capabilityBoundaries（1–4 条）、taboos（0–4 条）；单条 ≤ 200 字。
    - goals 为 1–4 条，每项恰有 4 键：horizon（"short" | "long"）、description、priority（1–5）、reason；不得输出 goalId 或 status。
  - quest 恰有 3 键：name、description、objective；objective 固定为 {"kind":"talk_to_opening_npc"}；不得暗示玩家已接取或完成。
  - situation 恰有 4 键：history、threads、npcConnection、responses。
    - 所有局部 key 长度 1–40，匹配 [a-z][a-z0-9_]*；history/threads/responses 各自 key 唯一。
    - history 0–4 条，每条恰有 4 键：key、factKeys（1–4）、participantRefs（1–2，取值仅 "player" 或 "opening_npc"）、causeHistoryKeys（0–4，只能引用同批更早的 history key）。
    - threads 1–3 条，每条恰有 5 键：key、questionFactKey（必须属于 knownFactKeys）、supportingFactKeys（0–4）、participantRefs、causeHistoryKeys。
    - npcConnection 恰有 3 键：familiarity、stance、basisHistoryKeys。
      familiarity 取 "stranger" | "known"；stance 取 "neutral" | "ally" | "protective_of" | "indebted_to" | "rival" | "wary"。
      familiarity="stranger" 时 stance 必须是 "neutral" 且 basisHistoryKeys 为 []。
    - responses 恰好 2 项，每项恰有 3 键：key、dialogueAct、topic。
      dialogueAct ∈ ${DIALOGUE_ACTS.join(" | ")}；topic 恰有 2 键：{"kind":"fact"|"thread","key": 键}（注意此处的键名是 key，不是 factId/threadId）。
      fact key 必须属于 knownFactKeys；thread key 必须属于已声明的 threads；两项的 act/topic 语义必须不同。`;
}

/** Builds the staged planning prompt: skeleton only, no presentation text. */
export function buildPlanningPrompt(context: PlanningContext, repair?: AiContentRepair): string {
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
    ? `- opening 必须为完整 OpeningGenerationCandidate（见下节），prologue/描述只是内容素材，最终序幕由 narration 单元覆盖后才发布。`
    : `- opening 必须为 null；决策链路禁止重跑开局结构编译。`;

  return `你是 RPG 的剧情规划 AI。本次调用只产出结构化骨架（PlanProposal JSON），不产出最终旁白、台词或选项 label；最终展示文本由后续 narration/character/choices 阶段生成。
${repairSection}
${openingSection}
${factSection(context)}
${branchSection(context)}
${jobSection(context)}

# 预算与规模上限
- 表达单元（narration/character/choices）总数不超过 ${MAX_PLAN_UNITS} 个。
- steps 不超过 ${MAX_NARRATIVE_BUNDLE_STEPS} 个；units 的依赖必须无环且不悬空。
- observations 每条必须有来源（speech 指明 speakerId，或 witness）；speech 观察的 certainty 不得高于说话人自身的认知。
- 恰好一个 choices 单元承接 decision${context.kind === "opening" ? "（开局两个候选来自 situation.responses）" : ""}；decision.point 必须与 choices 单元 point 一致，choices 之后不得再排单元。

# 创作要求
${openingTask}
- 用有限模板表达后果：分支的 visit_location/talk_to_npc 等目标由 decision options 声明，不发明任意效果。
- 规划的节拍链：服务端 mandatory beat 必须进入相应单元的 requiredBeats。
- choices 单元与 decision 的候选数都是 2；选项 label 由后续 choices 阶段生成，本阶段只声明结构。

${renderPlanProposalContract(context)}
${openingContractSection(context)}

# 顶层输出
只返回一个 JSON 对象，即 PlanProposal：顶层必须且只能有 opening、worldDelta、steps、units、observations、actions、decision、terminal。
禁止输出任何解释文字、Markdown 代码围栏或 JSON 之外的包装。所有自由文本使用中文；key 只用 [a-z][a-z0-9_]*，长度 ≤ 128。`;
}
