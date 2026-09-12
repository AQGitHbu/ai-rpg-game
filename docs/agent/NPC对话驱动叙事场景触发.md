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

固定选择保存玩家实际看到并选中的 label，以及已批准 dialogueAct/topic。统一规划器读取该原句、同一 NPC 的已展示对白和选项，在一次调用内写出本轮完整 NPC 回应和两个候选初稿。旁白、角色与选项表达器只润色自己的获批初稿，按场景和说话人裁剪上下文；旧 task 仅保留历史存档读取兼容。

同 NPC 连续对话依据实际选中的原句和已展示历史承接，保留精确 label 重复检查（`plan_dialogue_repeated`），不从旧 inquiries 推导新的提问或答案义务。一次规划写出自然回答与两个后续候选；不知道或拒答范围直接体现在完整初稿中。初稿与润色的安全和保真边界见 [运行时 AI](运行时AI导演与场景表演.md)。

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
