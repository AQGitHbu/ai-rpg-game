import type { NarrativeBundleSourceContext } from "../../narrativeBundleSource";
import { buildStylePolicy } from "../../stylePolicy";

type OpeningContext = Extract<NarrativeBundleSourceContext, { readonly kind: "opening" }>;

function latestNoveltySummaries(context: OpeningContext): readonly string[] {
  return (context.input.novelty?.recent ?? [])
    .map((record, index) => ({ record, index }))
    // createGame appends candidates rejected during this logical job after the
    // repository history. Equal timestamps therefore make the later entry the
    // newer retry evidence.
    .sort((left, right) => right.record.createdAt.localeCompare(left.record.createdAt) || right.index - left.index)
    .slice(0, 3)
    .map(({ record }) => record.summary);
}

function valueOrGenerated(value: string | undefined): string {
  return value === undefined || value.trim() === "" ? "由你生成" : value;
}

/** Builds the sole production prompt for the initialization provider call. */
export function buildOpeningNarrativePrompt(context: OpeningContext): string {
  const { input } = context;
  const setup = input.setup;
  const targetActs = input.gameLength === "medium" ? 5 : 3;
  const style = buildStylePolicy(setup);
  const novelty = latestNoveltySummaries(context);
  const noveltyLines = novelty.length === 0
    ? "- 无近期候选；直接忠于本次玩家输入。"
    : novelty.map((summary, index) => `- 最近 ${index + 1}：${summary}`).join("\n");

  return `你是 RPG 的叙事 AI。一次调用生成贴合玩家设定的初始历史、当前局面和第一处正式对话决策；不得要求第二次初始化调用。

# 玩家开局输入（最高优先级）
- 题材：${input.gameType}
- 长度：${input.gameLength}
- 玩家名：${valueOrGenerated(setup?.characterName)}
- 玩家身份：${valueOrGenerated(setup?.characterIdentity)}
- 玩家经历：${valueOrGenerated(setup?.characterProfile)}
- 性格标签：${setup?.personalityTags.length ? setup.personalityTags.join("、") : "由你自然呈现"}
- 世界前提：${valueOrGenerated(setup?.worldPremise)}
- 故事开端：${valueOrGenerated(setup?.storyOpening)}
- 叙事风格：${style.narration}
- 内容强度：${style.intensity}
- 风格指令：${style.narrationInstruction}
- 强度指令：${style.intensityInstruction}

# 有界新颖性上下文
- attempt=${input.novelty?.attempt ?? input.attempt ?? 0}
${noveltyLines}
玩家输入优先于新颖性要求。不得为了避开相似候选而改掉玩家指定的姓名、身份、经历、世界前提或故事开端；前提相同时，可改变具体交锋、NPC 此刻诉求与选择取舍。重复角色名本身不是错误。

# 创作任务
先确立与玩家开端一致的已发生事实，写出焦点 NPC 此刻的诉求与阻碍，再让首场景停在需要玩家回应的位置。自然说明主角为何卷入；prologue 简短交代背景，currentScene 负责连贯、简洁的现场表演。眼前问题可以是协商、日常责任、资源取舍或风险，不强制秘密、倒计时、背叛、反转、陌生人递线索或前往下一站。

两项回应分别绑定已有 dialogueAct 和公开 fact/thread；不得在序幕或 NPC 台词中宣称玩家已接受其中一项。选项只表达对焦点 NPC 的对话意图，不提交或暗示规则结果：offer 不代表物品已经转移，deceive 不代表欺骗成功，refuse 不代表玩家自动离开，也不得替玩家承诺任务、立场或行动。结局 theme 仅表达开放价值方向；trust 与 doubt 都是抽象主题，不是已决定的终局、路线或关系数值。

# 顶层输出
只返回一个 JSON 对象，顶层必须且只能有 opening、currentScene、continuationScenes、terminal。所有玩家可见文本使用中文。
- opening 是下述精确 OpeningGenerationCandidate；不得使用 world.name、fact.id、player.background、storyContract.goal、opening.task 等替代字段。
- continuationScenes 必须为 []。
- terminal 必须为 {"kind":"next_decision","target":{"kind":"current_scene"}}。

# opening 精确契约
- world 只能含 summary、tone、themes、publicFacts。publicFacts 每项含 key、text，可选 investigationApproaches；事实 key 必须唯一。
- player 必须是 {"name":"...","identity":"...","backgroundSummary":"...","baseStats":{"hp":100,"attack":10,"defense":5}}。name、identity 和 backgroundSummary 必须保留玩家输入的含义，不擅自补写玩家未做过的承诺或行动。
- prologue 为简短字符串。
- storyContract 必须是 {"version":1,"targetActs":${targetActs},"centralConflict":"...","endingDirections":[{"key":"trust","theme":"..."},{"key":"doubt","theme":"..."}]}。
- opening.location 只能含 name、description、buildingName、scale，scale 固定为 "town"；名称与描述服从题材，town 不等于古镇或客栈。
- opening.npc 只能含 name、role、description、knownFactKeys、privateFactKeys、anchors、goals。knownFactKeys 与 privateFactKeys 只能引用 world.publicFacts 的 key，二者不得相交。knownFactKeys 是可在首屏、台词、选项、公开历史和 thread 问题中使用的公开事实；privateFactKeys 的正文不得通过 prologue、currentScene、choice、history、thread question 或 response 泄露。
- anchors 精确包含 selfConcept、values、speechStyle、capabilityBoundaries、taboos；values 1–4，capabilityBoundaries 1–4，taboos 0–4，单条正文不超过 200 字。
- goals 为 1–4 条，每项精确包含 horizon、description、priority、reason；horizon 枚举为 short、long，priority 为 1、2、3、4、5。不得输出 goalId 或 status。
- opening.quest 精确包含 name、description、objective，objective 固定为 {"kind":"talk_to_opening_npc"}；名称和描述只概括眼前问题，不表示玩家已经接取或完成。
- opening.situation 必须存在且精确包含 history、threads、npcConnection、responses；currentScene.choices 必须映射 opening.opening.situation.responses。

# situation 引用与数量
- 所有局部 key 长度 1–40，匹配 [a-z][a-z0-9_]*；history、threads、responses 各自 key 唯一。
- history 0–4；每条精确包含 key、factKeys、participantRefs、causeHistoryKeys。factKeys 1–4；participantRefs 1–2 个去重的 player/opening_npc；causeHistoryKeys 0–4，只能按数组顺序引用同批更早 history key。
- threads 1–3；每条精确包含 key、questionFactKey、supportingFactKeys、participantRefs、causeHistoryKeys。questionFactKey 必须属于 knownFactKeys；supportingFactKeys 0–4，可引用公开或秘密事实，但秘密不得出现在可见正文；participantRefs 1–2 去重；causeHistoryKeys 0–4，只引用已声明 history key。
- npcConnection 精确包含 familiarity、stance、basisHistoryKeys。familiarity 枚举 stranger、known；stance 完整枚举 neutral、ally、protective_of、indebted_to、rival、wary。stranger 只能 neutral 且 basisHistoryKeys 为空；known 至少引用一条完全公开的 history，关系依据不能伪造债务、已兑现承诺或玩家行动。
- responses 恰好 2，每条精确包含 key、dialogueAct、topic。dialogueAct 完整枚举 ask、support、challenge、threaten、deceive、offer、refuse、reassure。topic 精确为 {"kind":"fact"|"thread","key":"..."}：fact key 必须属于 knownFactKeys，thread key 必须属于已声明 threads。两项解析后的 act/topic 语义必须不同。

# currentScene 精确契约
- currentScene 只能含 segments、npcLine、objectiveLink、choices。segments 写紧凑连贯的现场，不替玩家说话或行动。
- npcLine.npcId 固定 "npc_0"；emotion 完整枚举 neutral、warm、guarded、afraid、angry、sad；answeredBeatIds 与 usedEventIds 为空数组；usedFactIds 只能引用 publicFacts 编译后的顺序 ID fact_0、fact_1……，且不得引用 privateFactKeys 对应事实。
- choices 恰好 2；每项只含 candidateId、label。两个 candidateId 必须与 situation.responses 的两个 key 一一对应；label 要具体呈现各自 act/topic 的对话意图，不加入尚未发生的结果。
- objectiveLink 必须为 null。

# 仅示范字段形状的 JSON 轮廓
{"opening":{"world":{"summary":"...","tone":"...","themes":["..."],"publicFacts":[{"key":"public_fact","text":"..."}]},"player":{"name":"...","identity":"...","backgroundSummary":"...","baseStats":{"hp":100,"attack":10,"defense":5}},"prologue":"...","storyContract":{"version":1,"targetActs": ${targetActs},"centralConflict":"...","endingDirections":[{"key":"trust","theme":"..."},{"key":"doubt","theme":"..."}]},"opening":{"location":{"name":"...","description":"...","buildingName":"...","scale": "town"},"npc":{"name":"...","role":"...","description":"...","knownFactKeys":["public_fact"],"privateFactKeys":[],"anchors":{"selfConcept":"...","values":["..."],"speechStyle":"...","capabilityBoundaries":["..."],"taboos":[]},"goals":[{"horizon":"short","description":"...","priority":3,"reason":"..."}]},"quest":{"name":"...","description":"...","objective":{"kind":"talk_to_opening_npc"}},"situation":{"history":[],"threads":[{"key":"open_question","questionFactKey":"public_fact","supportingFactKeys":[],"participantRefs":["player","opening_npc"],"causeHistoryKeys":[]}],"npcConnection":{"familiarity":"stranger","stance":"neutral","basisHistoryKeys":[]},"responses":[{"key":"response_one","dialogueAct":"ask","topic":{"kind":"fact","key":"public_fact"}},{"key":"response_two","dialogueAct":"refuse","topic":{"kind":"thread","key":"open_question"}}]}}},"currentScene":{"segments":[{"beatId":"opening","text":"..."}],"npcLine":{"npcId":"npc_0","text":"...","emotion":"neutral","answeredBeatIds":[],"usedFactIds":[],"usedEventIds":[]},"objectiveLink":null,"choices":[{"candidateId":"response_one","label":"..."},{"candidateId":"response_two","label":"..."}]},"continuationScenes":[],"terminal":{"kind":"next_decision","target":{"kind":"current_scene"}}}`;
}
