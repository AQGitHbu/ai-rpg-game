import type { StoryConsequenceBindingsProposal } from "@/game/domain/storyConsequenceBindings";

/** Field shapes for the existing binding parser and approval; never a required story recipe. */
export function storyConsequenceBindingPrompt(mode: "opening" | "decision"): string {
  const factRef = mode === "opening" ? "public_fact" : "@new.fact";
  const examples: StoryConsequenceBindingsProposal = [
    { kind: "bind_goal_resolution", npcRef: "@new.npc", goalOrdinal: 0,
      resolution: { completeWhen: [{ kind: "knows_fact", actorId: "@new.npc", factId: factRef }], blockWhen: [] } },
    ...(mode === "opening" ? [] : [{ kind: "bind_investigation" as const, factRef, discoveryMode: "investigation" as const,
      approaches: [
        { approachId: "quiet", label: "独自查验", evidenceQuality: "clean" as const, tensionDelta: 0, requirements: [], witnessNpcIds: [] },
        { approachId: "witnessed", label: "请在场者见证查验", hint: "由在场见证者共同确认", evidenceQuality: "noisy" as const, tensionDelta: 2, witnessNpcIds: ["@new.npc"] },
      ] }]),
    { kind: "bind_talk_completion", questRef: "@new.quest", npcRef: "@new.npc",
      conditions: [{ kind: "goal_status", npcId: "@new.npc", goalOrdinal: 0, status: "completed" }] },
    { kind: "bind_npc_cooperation", npcRef: "@new.npc", definitions: [{ operation: "request_verification",
      requirements: [{ kind: "goal_status", npcId: "@new.npc", goalOrdinal: 0, status: "completed" }],
      allowedFactIds: [factRef], allowedAudienceIds: ["player_0"] }] },
  ];
  return [
    "consequenceBindings 是可选的有限规则绑定数组，未需要时省略或 []；不要求每个故事创建调查或合作。总计最多 8 条，字段精确按以下形状，不能添加状态/数值补丁。示例仅说明字段，引用必须替换成当前真实对象，不代表要求照搬组合。",
    mode === "opening"
      ? "位置：OpeningGenerationCandidate.opening.consequenceBindings（整场输出为 opening.opening.consequenceBindings），不能放在整场顶层。开局 town 不允许 bind_investigation；可选绑定目标、交谈条件、合作定义。"
      : "位置：整场顶层 consequenceBindings 或 worldDelta.consequenceBindings，两处合计最多 8 条，不重复提交同一绑定；worldDelta=null 时使用顶层。仅在本轮允许的 worldDelta 中创建新对象。",
    `绑定形状示例：${JSON.stringify(examples)}`,
    "bind_goal_resolution：npcRef 指向已有 active NPC 或同包新 NPC；goalOrdinal 是该 NPC 原始 goals 数组的从 0 开始的索引，必须实际存在，不能按过滤后的列表重新编号。resolution 精确含 completeWhen、blockWhen，两数组各 0–4 个条件；同一非空数组全部满足才触发，空数组不触发。只安装规则，不设置 goalId/status，不让旧事件追溯完成目标。",
    "bind_talk_completion：questRef 必须引用真实 quest，npcRef 必须对应其中已有的 talk_to_npc 目标；conditions 为 1–4 个条件，全部满足且本人真实交谈才完成。首次绑定不能追溯完成已经结算的旧交谈。",
    "bind_npc_cooperation：definitions 0–2 条，每种 operation 最多一条；operation 仅 request_introduction 或 request_verification。每条 requirements 为 1–4 个条件，必须含该 npcRef 本人目标的 goal_status。allowedFactIds、allowedAudienceIds 均为非空去重数组，分别引用真实 fact 和 player_0/active NPC；不能把说话人自己当作实际合作受众。空 definitions 表示不开放这两种合作。合作仍需真实知识、证据、实际听众与披露权限；安装定义不等于已合作。",
    "条件精确形状（任意 conditions/requirements/completeWhen/blockWhen 共用）：{\"kind\":\"has_item\",\"itemId\":\"物品引用\",\"ownerId\":\"持有者引用\"}；{\"kind\":\"knows_fact\",\"actorId\":\"player_0或NPC引用\",\"factId\":\"事实引用\"}；{\"kind\":\"promise_status\",\"npcId\":\"NPC引用\",\"promiseId\":\"该NPC已存在的承诺ID\",\"status\":\"open|fulfilled|broken|released\"}；{\"kind\":\"goal_status\",\"npcId\":\"NPC引用\",\"goalOrdinal\":0,\"status\":\"active|blocked|completed|abandoned\"}（goalOrdinal 与已存在的 goalId 二选一，不能同时提供）；{\"kind\":\"investigation_observed\",\"npcId\":\"NPC引用\",\"factId\":\"事实引用\",\"evidenceQuality\":\"clean|noisy\"}。不得编造 promiseId/goalId。",
    mode === "opening"
      ? "开局引用：@new.location、@new.npc、@new.quest；确实生成 opening.item 时可用 @new.item。factRef/factId/allowedFactIds 使用 world.publicFacts 的实际 key（示例 public_fact 须替换）；玩家为 player_0。开局没有 @new.fact 或 @current.focus_npc。新 NPC 的 goalOrdinal 对应本包 opening.npc.goals。"
      : "决策引用：使用上下文已有正式 ID；@current.location 指当前地点。绑定不支持 @current.focus_npc，已有 NPC 的 npcRef/npcId/actorId 必须使用实体卡的正式 NPC ID；场景表达字段中的焦点别名仍遵守各自场景契约。@new.location/@new.npc/@new.item/@new.enemy/@new.fact/@new.quest 仅指本包 worldDelta 实际创建且保留的对应实体；引用字段必须匹配实体种类。新 NPC 的 goalOrdinal 对应本包 worldDelta.newNpc.goals；已有 NPC 仅引用实体卡中提供的 goalBindings 元数据，不能猜测未提供目标。",
    ...(mode === "opening" ? [] : [
      "bind_investigation：精确为 {kind,factRef,discoveryMode,approaches}，discoveryMode 固定 investigation，事实必须未发现且位于独立 scale=scene 地点，必须已有非空 investigationLabel，town 不可调查。可首次绑定上下文内已有的合法未发现 scene fact，使用其正式 factId，无需新增 worldDelta；若本包新建调查现场，则由 newLocation/newFact 提供独立 scene 与事实，factRef=@new.fact。approaches 恰好 2–3 条，approachId 非空且唯一，label 非空，可选非空 hint；label/hint 不泄漏待查事实正文；evidenceQuality=clean|noisy，tensionDelta 为 [-5,20] 有限数值，可选 requirements（0–4 条）及 witnessNpcIds（去重 NPC 引用数组）。必须用 approaches 字段，不是 methods。基础字段与 newFact.investigationApproaches 的同一方法对应；requirements/witnessNpcIds 权威放在绑定 approaches。",
      "witnessNpcIds=[] 或省略表示没有额外 NPC 见证；指定见证人必须 active 且在实际调查时同场。私下调查不会自动给 NPC 知识；investigation_observed 需要该 NPC 实际见证匹配证据类型，knows_fact 可在真实告知后满足。提供的所有方法不能都依赖自身尚未发现的事实或无法达成的目标；须保留可执行的起点。仅写 investigationApproaches 不启用调查。",
    ]),
    "已有绑定不可删除、替换或削弱；hasResolution=true 的目标已安装规则。绑定只是未来规则，不授予事实、权限、完成状态或关系变化；不得向公共文本输出私密目标 description/reason 或隐藏条件。",
  ].join("\n");
}
