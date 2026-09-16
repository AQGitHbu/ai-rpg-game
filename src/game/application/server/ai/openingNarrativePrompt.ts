import { storyConsequenceBindingPrompt } from "./storyConsequenceBindingPrompt";
import { storyInteractionPrompt } from "./storyInteractionPrompt";
import type { NarrativeBundleSourceContext } from "../../narrativeBundleSource";
import { renderAiRepairFeedback } from "../../aiGenerationRetry";
import { buildStylePolicy } from "../../stylePolicy";
import { OPENING_SEMANTIC_CONTRACT } from "./openingSemanticContract";
import { renderNarrativeCandidateRevision } from "./narrativeCandidateRevisionPrompt";

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
${OPENING_SEMANTIC_CONTRACT}
${storyInteractionPrompt(true)}
${renderNarrativeCandidateRevision(context.candidateRevision)}
${context.contentRepair === undefined ? "" : `
# 上次生成的拒绝原因
${renderAiRepairFeedback(context.contentRepair)}
请依据下面的精确契约修复并重新输出完整 JSON。opening_INVALID_FACT 时检查 publicFacts 和 investigationApproaches 对象字段；invalid_response_reference 时检查 situation 引用、公开权限和 npcConnection：stranger 必须 neutral 且 basisHistoryKeys=[]，不能因为初见时的戒备表情改成 wary；情绪可由 npcLine.emotion=guarded 表达。
`}

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
先确立与玩家开端一致的已发生事实，写出焦点 NPC 此刻的诉求与阻碍，再让首场景停在需要玩家回应的位置。玩家故事开端中明确写出的已发生关键因果必须进入 publicFacts 和 history，并在 prologue 或 currentScene 中承接；不得因 novelty 省略、反转或改成未知谜题。故事开端明确的人物关系与“正在等待回应”等当前状态必须保持。自然说明主角为何卷入；prologue 简短交代背景，currentScene 负责连贯、简洁的现场表演。眼前问题可以是协商、日常责任、资源取舍或风险，不强制秘密、倒计时、背叛、反转、陌生人递线索或前往下一站。

输出前检查事实之间的数量、单位、时间与资源增减是否与因果结果一致，例如减少资源不能反而自然推出用量增加，金额与日期不能混作同一单位。允许生成必要的新细节并先在 publicFacts/history 中确立，但玩家输入未给精确数字时，不要只为戏剧性补出未经支撑的精确数值；姓名、关系和已发生行动不得在不同字段间改变。

两项回应分别绑定已有 dialogueAct 和公开 fact/thread；不得在序幕或 NPC 台词中宣称玩家已接受其中一项。选项只表达对焦点 NPC 的对话意图，不提交或暗示规则结果：offer 不代表物品已经转移，deceive 不代表欺骗成功，refuse 不代表玩家自动离开，也不得替玩家承诺任务、立场或行动。不能借选项补写新的既成事实、先前承诺、已完成动作或玩家已经掌握的信息。每个 label 只能是对焦点 NPC 说出的回应，必须忠于对应 dialogueAct/topic；不得用“转身、推门、调出、接通、拿出、前往”等物理行动冒充 talk 选择。结局 theme 仅表达开放价值方向；trust 与 doubt 都是抽象主题，不是已决定的终局、路线或关系数值。

# 顶层输出
只返回一个 JSON 对象，顶层必须有 opening、currentScene、continuationScenes、terminal，可额外有 interactionProposals。所有玩家可见文本使用中文。
- opening 是下述精确 OpeningGenerationCandidate；不得使用 world.name、fact.id、player.background、storyContract.goal、opening.task 等替代字段。
- continuationScenes 必须为 []。
- terminal 必须为 {"kind":"next_decision","target":{"kind":"current_scene"}}。

# opening 精确契约
- world 只能含 summary、tone、themes、publicFacts。publicFacts 每项含 key、text，可选 investigationApproaches；事实 key 必须唯一。
- investigationApproaches 不需要时省略或为 []；非空时必须是 2–3 项对象数组，不能是字符串数组。每项精确包含 approachId、label、evidenceQuality、tensionDelta，可选 hint；approachId 非空且列表内唯一，label 和提供的 hint 非空且不能包含完整事实正文；evidenceQuality 只能为 clean 或 noisy，tensionDelta 必须为 [-5,20] 内的有限数值。无法完整提供时省略该可选字段。
- player 必须是 {"name":"...","identity":"...","backgroundSummary":"...","baseStats":{"hp":100,"attack":10,"defense":5}}。name、identity 和 backgroundSummary 必须保留玩家输入的含义，不擅自补写玩家未做过的承诺或行动。
- prologue 为简短字符串。
- storyContract 必须是 {"version":1,"targetActs":${targetActs},"centralConflict":"...","endingDirections":[{"key":"trust","theme":"..."},{"key":"doubt","theme":"..."}]}；递送型开局可额外包含 delivery={"itemKey":"...","recipientKey":"...","verificationFactKeys":["public_fact"]}，这些是本地 key，核验 key 必须来自 publicFacts。
- opening.location 只能含 name、description、buildingName、scale，scale 固定为 "town"；名称与描述服从题材，town 不等于古镇或客栈。
- opening.npc 只能含 name、role、description、knownFactKeys、privateFactKeys、anchors、goals。knownFactKeys 与 privateFactKeys 只能引用 world.publicFacts 的 key，二者不得相交。knownFactKeys 是可在首屏、台词、选项、公开 history 渲染和 thread 问题中使用的公开事实。privateFactKeys 可被 history.factKeys 引用并存入 ledger，history.factKeys 不要求全部属于 knownFactKeys；但私密事实正文不得出现在 prologue、currentScene、choices、公开 history 渲染、thread question 或 response。
- 递送型开局才在 opening.item 建立一件唯一任务物品，精确包含 key、name、description、kind、tags；item.key 必须等于 storyContract.delivery.itemKey。owner 由服务端固定为 player，开局 NPC 是委托方；接应目标只保留本地 recipientKey，在最终幕主线 NPC 具象化时由规则绑定，不在开局预生成 NPC 或 runtime ID；没有明确递送开端时省略 item/delivery。
- anchors 精确包含 selfConcept、values、speechStyle、capabilityBoundaries、taboos；values 1–4，capabilityBoundaries 1–4，taboos 0–4，单条正文不超过 200 字。
- goals 为 1–4 条，每项精确包含 horizon、description、priority、reason；horizon 枚举为 short、long，priority 为 1、2、3、4、5。不得输出 goalId 或 status。
- opening.quest 精确包含 name、description、objective，objective 固定为 {"kind":"talk_to_opening_npc"}；名称和描述只概括眼前问题，不表示玩家已经接取或完成。
- opening.situation 必须存在且精确包含 history、threads、npcConnection、responses；currentScene.choices 必须映射 situation.responses 或同包 interactionProposals。
- opening.location.scale 固定为 town，初始化不能在 opening.consequenceBindings 使用 bind_investigation，也不能把 investigationApproaches 当作开局可执行调查；opening 中的 approaches 只能作为后续线索的展示字段。若故事开端要求玩家在第一幕先选择可主动调查的方法，必须由后续独立 scene 的 worldDelta.newFact 与 worldDelta.consequenceBindings 实际创建并激活：使用 factRef="@new.fact"、discoveryMode="investigation" 和恰好 2–3 个 approaches；其中至少一条 witnessNpcIds=[]，至少一条 witnessNpcIds=["@new.npc"]。仅写 opening 的 investigationApproaches 或使用 automatic 事实不满足。

# 可选规则绑定
${storyConsequenceBindingPrompt("opening")}

# situation 引用与数量
- 所有局部 key 长度 1–40，匹配 [a-z][a-z0-9_]*；history、threads、responses 各自 key 唯一。
- history 0–4；每条精确包含 key、factKeys、participantRefs、causeHistoryKeys。factKeys 1–4；participantRefs 1–2 个去重的 player/opening_npc；causeHistoryKeys 0–4，只能按数组顺序引用同批更早 history key。
- threads 1–3；每条精确包含 key、questionFactKey、supportingFactKeys、participantRefs、causeHistoryKeys。questionFactKey 必须属于 knownFactKeys；supportingFactKeys 0–4，可引用公开或秘密事实，但秘密不得出现在可见正文；participantRefs 1–2 去重；causeHistoryKeys 0–4，只引用已声明 history key。
- npcConnection 精确包含 familiarity、stance、basisHistoryKeys。familiarity 枚举 stranger、known；stance 完整枚举 neutral、ally、protective_of、indebted_to、rival、wary。stranger 只能 neutral 且 basisHistoryKeys 为空；known 至少引用一条完全公开的 history，关系依据不能伪造债务、已兑现承诺或玩家行动。
- responses 恰好 2，每条精确包含 key、dialogueAct、topic。dialogueAct 完整枚举 ask、support、challenge、threaten、deceive、offer、refuse、reassure。topic 精确为 {"kind":"fact"|"thread","key":"..."}：fact key 必须属于 knownFactKeys，thread key 必须属于已声明 threads。两项解析后的 act/topic 语义必须不同。

# currentScene 精确契约
- currentScene 只能含 segments、npcLine、objectiveLink、choices。segments 写紧凑连贯的现场，不替玩家说话或行动。
- npcLine.npcId 固定 "npc_0"；emotion 完整枚举 neutral、warm、guarded、afraid、angry、sad；answeredBeatIds 与 usedEventIds 为空数组；usedFactIds 只能引用 publicFacts 编译后的顺序 ID fact_0、fact_1……，且不得引用 privateFactKeys 对应事实。
- choices 恰好 2；每项只含 candidateId、label。candidateId 必须与 situation.responses 的 key 或 interaction:proposalKey 对应；label 要具体呈现各自 act/topic 的对话意图，不加入尚未发生的结果。
- objectiveLink 必须为 null。

# 仅示范字段形状的 JSON 轮廓
 {"opening":{"world":{"summary":"...","tone":"...","themes":["..."],"publicFacts":[{"key":"public_fact","text":"...","investigationLabel":"查验...","investigationApproaches":[{"approachId":"quiet","label":"...","evidenceQuality":"clean","tensionDelta":0}]}]},"player":{"name":"...","identity":"...","backgroundSummary":"...","baseStats":{"hp":100,"attack":10,"defense":5}},"prologue":"...","storyContract":{"version":1,"targetActs": ${targetActs},"centralConflict":"...","endingDirections":[{"key":"trust","theme":"..."},{"key":"doubt","theme":"..."}]},"opening":{"location":{"name":"...","description":"...","buildingName":"...","scale": "town"},"npc":{"name":"...","role":"...","description":"...","knownFactKeys":["public_fact"],"privateFactKeys":[],"anchors":{"selfConcept":"...","values":["..."],"speechStyle":"...","capabilityBoundaries":["..."],"taboos":[]},"goals":[{"horizon":"short","description":"...","priority":3,"reason":"..."}]},"quest":{"name":"...","description":"...","objective":{"kind":"talk_to_opening_npc"}},"consequenceBindings":[],"situation":{"history":[],"threads":[{"key":"open_question","questionFactKey":"public_fact","supportingFactKeys":[],"participantRefs":["player","opening_npc"],"causeHistoryKeys":[]}],"npcConnection":{"familiarity":"stranger","stance":"neutral","basisHistoryKeys":[]},"responses":[{"key":"response_one","dialogueAct":"ask","topic":{"kind":"fact","key":"public_fact"}},{"key":"response_two","dialogueAct":"refuse","topic":{"kind":"thread","key":"open_question"}}]}}},"currentScene":{"segments":[{"beatId":"opening","text":"..."}],"npcLine":{"npcId":"npc_0","text":"...","emotion":"neutral","answeredBeatIds":[],"usedFactIds":[],"usedEventIds":[]},"objectiveLink":null,"choices":[{"candidateId":"response_one","label":"..."},{"candidateId":"response_two","label":"..."}]},"continuationScenes":[],"terminal":{"kind":"next_decision","target":{"kind":"current_scene"}}}

# 生成前的本次输入锚点
再次核对故事开端原文：${valueOrGenerated(setup?.storyOpening)}
原文明确给出的原因、人物关系与玩家约束都是不可替换的锚点：允许自然改写措辞，但必须分别进入 publicFacts/history，并在 prologue 或 currentScene 首屏自然呈现。novelty 只能影响补充背景、现场交锋与选项取舍，不能把这些锚点换成同题材的另一件事，也不能把已发生因果改成未知谜题。
资源短缺本身不能自动扩写成未经事实支持的物理效果。对数量、时间、浓度或资源增减的推论，若 publicFacts/history 没有建立必要条件且无法确认，就删去该推论，只呈现已给出的资源冲突与实际取舍。`;
}
