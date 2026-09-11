# NPC 对话驱动叙事场景触发

## 职责

焦点 NPC 对话是正式叙事决策入口。系统负责把服务端批准的选择或自定义输入提交为规则回合，并让生产分阶段链路整包提供当前场景与后续已批准步骤；AI 只负责提案和表达。

## 当前契约

- 普通 ready 焦点场景提供恰好两个固定回应和一个自定义输入；交接只提供承接入口，终幕立场不开放自由输入。自定义输入必须绑定当前焦点 NPC，每次请求使用新的 `actionId`。
- 对话会话至少经过两轮正式回应后才完成 `talk_to_npc`；`met` 只表示接触，不能代替 `npc_dialogue_completed`。
- 固定选择与自定义输入都走 `POST /api/game/actions` → `performTurn` → 单次规则 CAS。不存在独立 dialogue route 或 dialogue use case。
- 正式回合的生成与审批由 [运行时 AI](运行时AI导演与场景表演.md) 编排；界面提交后保留对话快照并显示 waiting，ready 后显示新回应与入口。
- `speechPurpose=focus|ambient` 区分正式回应与非焦点环境台词；`speechSource=generated` 只描述来源。读模型不会把 ambient 台词当作正式目标对白，也不会在读取时补写正式对白。
- 目标交接由旧焦点 NPC 的最后一句回应和一个具体 handoff choice 承接；本地关闭 handoff 不创建 action、token、pending 或 revision。非焦点 ambient 对话是只读展示。
- 规则移动返回目标地点时，ready `dialogueResume` 可按当前 revision 重铸 token 恢复未消费对白；没有缓存时只由目标 NPC 的权威 `ask` 入口生成正式 scene。
- AI 失败进入 `provider_failed`，保留同一 job，用户显式重试；生产失败不会改写为成功场景。
- 选择候选、焦点 NPC、NPC 可说事实、`objectiveLink` 和台词引用均由审批器按当前权威状态校验；越权引用或不符合上下文的包拒绝并进入内容修复/失败。

## 对话承接与选项

普通选项的已批准 `task` 随服务端 registry/后续场景种子保存，固定选择时进入 `selectedDialogue.task`。统一规划器读取当前玩家选择、同一 NPC 上一轮实际对白和两条已展示选项，先决定本轮 NPC 回应内容，再决定两个后续候选；开局同样由一次规划确定整轮语义。旁白、角色与选项表达器只润色各自授权任务，按场景和说话人裁剪上下文，契约见 [运行时 AI](运行时AI导演与场景表演.md)。

同 NPC 当前场景的新问询不得重复刚问过的具体维度，换 act、附加新问题或删除 inquiries 不消除重复（`plan_dialogue_repeated`）。无答案时规划器明确安排不知道或拒答，后续候选应转向新问题、其他授权线索或态度表达；不固定为 ask/challenge，也不机械保留上一轮未选项。旧存档/自由输入没有结构化维度时按实际原话承接，不从文本猜造权威维度。结构校验不能证明任意自然语言绝无重复，仍需多轮真实样本验证。

## 交互流程

打开已准备的 NPC 对话 → 提交固定选择或自由输入 → 保留对白并等待 → 展示直接回应 → 继续同一 NPC 或按目标交接。

非焦点 NPC 使用同场景已生成的 ambient 台词，只读展示；缺少正式 focus 内容的目标 NPC 由权威 ask 提交生成。规则消费和原子提交见 [行动裁决](行动裁决.md)。

## 主要源码和验证

- `src/components/NpcDialogueOverlay.tsx`、`src/components/AdventureGameShell.tsx`、`src/components/gameActionRequest.ts`
- `src/game/application/performTurn.ts`、`src/game/application/narrativeGeneration/runJob.ts`、`src/game/application/narrativeGeneration/approveUnit.ts`、`src/game/application/npcSpeechAuthority.ts`
- `src/game/domain/narrative.ts`、`src/game/domain/npcSpeech.ts`、`src/game/domain/approvedChoice.ts`
- `src/game/application/gameSessionView.ts`、`src/game/application/buildChoiceMap.ts`
- `src/game/gameplay/rpg/narrativePlanning/index.ts`、`src/game/gameplay/rpg/dialogue/index.ts`、`src/game/gameplay/rpg/narrativeContext/index.ts`
- `src/game/application/testing/narrativeGroundingJourney.test.ts`、`src/game/application/testing/npcContinuityJourney.test.ts`、`src/game/application/testing/storyDivergenceJourney.test.ts`、`src/game/application/narrativeGeneration/runJob.test.ts`
- `src/components/NpcDialogueOverlay.test.tsx`、`src/game/application/npcSpeechAuthority.test.ts`、`src/game/application/approveAndWriteScene.test.ts`、`src/game/application/performTurn.test.ts`

## 按条件关联文档

- 地图、建筑和目标入口见 [地图与地点冒险](./地图与地点冒险.md)。
- 行动合法性和 CAS 见 [行动裁决](./行动裁决.md)；终幕立场见 [战斗与结局](./战斗与结局.md)。
