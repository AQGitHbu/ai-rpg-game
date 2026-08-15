# NPC 对话驱动叙事场景触发

## 系统定位

NPC 对话是持续推进故事的主要入口。每个 ready 的焦点 NPC 场景必须给玩家两个语义不同的固定对白选择和一个自定义输入；两种输入共享一条 application/API/CAS 链，不能有“闲聊不记回合”或独立 dialogue use case 旁路。

## 玩家可见规则

- 当前场景只有一个焦点 NPC；其面板显示恰好两个固定选择和一个自定义输入。
- 小镇建筑只负责进入建筑场景，不提交回合；地点行动栏中的明确 talk 行动只打开该 NPC 已预生成的 dialogue scene。焦点对话必须展示两个固定选择和一个自定义输入，只有选择或提交自定义输入才发起正式回合；点击 NPC 资料卡仍只查看信息，observe 场景中的 NPC 旁白不构成焦点对话。
- 固定选择由服务器批准并以 opaque `choiceToken` 下发；客户端只显示 label/hint，不知道 Action 或 `actionKey`。
- 自定义输入必须绑定当前焦点 NPC。每次提交生成新的浏览器 UUID，即使连续对同一 NPC 输入也分别计为独立回合。
- 玩家输入表达意图，不声明事实。服务端意图解析器只能转换成当前受支持 Action；越权声明不能直接改变任务、知识、关系、物品、战斗或结局。
- 每个成功输入都会推进 `turnNumber`、更新结构化 NPC 记忆/关系、产生一个 `PendingNarrativeJob`；服务端在规则写入成功后立即后台排队下一幕，不等待玩家再次点击或客户端 ensure 才开始生成。
- 当一次对话完成当前幕并具象化出下一任务时，新场景是非焦点的任务交接场景：上一名 NPC 立即失去双选项/自定义输入，场景选择优先包含权威新目标；新出现的 NPC 不会被界面自动打开。
- 交接离开当前建筑/地点时，旧焦点对话框和旧行动栏一起关闭；玩家回到地图/小镇进入新目标后，才由新 NPC 提供正式对白，避免旧 NPC 的双选项伪装成新主线。
- 若权威当前目标要求与另一名在场 NPC 交谈，支线 NPC 在完成一次支持/质疑后回到普通“与 NPC 交谈”入口；玩家只有再次主动提交该入口的 `ask` 行动，才开启一轮新的焦点对话，避免同一组 support/challenge 选项自动循环铸造，同时保留自由回访角色的能力。
- 新地点刚被编排出来时，场景事件可能仍是 travel/observe；只要当前主线目标已锁定该地点的焦点 NPC，read model 仍可从权威目标铸造两项 opaque 的 support/challenge 回应，并接受绑定该 NPC 的自定义对白，不能要求玩家重复点击一次无意义的交谈入口。
- 同一幕可以预先具象化后续 NPC、证物和敌人，但只有当前释放目标对应的实体进入场景与 NPC 上下文。前置调查未完成时不展示远端 NPC；玩家抵达新地点后，NPC 首句必须承接已完成的调查事实与到达过程，不能默认双方已经交换过密信、腰牌或完整案情。
- 正式对白提交后进入“等待 NPC 回应”态，pending 期间暂时隐去旧台词；后台写回 ready 快照后，UI 自动回到同一 NPC 的对话框，先展示其对玩家输入的回应。回应阶段不展示旧 token 或新选项，玩家点击“继续对话/查看下一步”后才恢复下一组选项或关闭旧焦点；若目标变化，回应框同时显示权威“下一步：<目标>”，不从旁白或 NPC 名称猜任务。
- 玩家原文不写入长期记忆、事件账本或日志；长期记录只保存规则归一化的 dialogue act、topic summary 和 fact IDs。
- `npcLine.text` 是直接展示给玩家的 NPC 第一人称台词正文，不得包含 NPC 名称、角色动作或“说道/答道”等叙述性前缀；点击 NPC 时 UI 已经单独展示名称。
- NPC 回应必须承接当前玩家话语或当前交谈情境；“我知道了”“好的”“嗯”等无对象确认句，以及“你想问哪一段 / 你还想了解什么”这类只把责任推回玩家的空泛追问，都不是合法的上下文回应，live source 会拒绝并走带角色线索的确定性 fallback。
- “承接”不等于复读玩家原文。NPC 必须以角色自身的第一人称口吻给出回答、可核对的线索、保留或下一步；禁止以“你刚才问的……”加引号复述长句来充当回复。
- 焦点 NPC 的 ready 台词至少包含两句直接对白：第一句回应当前问题或线索，第二句继续补充、追问或给出下一步；审批器会拒绝焦点开场、正式回应或终局追问中的单句台词，live source 因此回退到同轨角色化多轮台词。
- 确定性 fallback 按 NPC 角色补足上下文：传讯人承接旧案线索，幸存者承接失踪镖队，卷宗保管人承接证据交接，终幕知情人承接盟誓铁印；不再对所有新 NPC 使用无剧情关系的“欢迎光临”模板。
- 真机 AI 验收只接受持久化 `narrative.currentScene.source = generated` 的回合；台词即使由角色化 fallback 写得通顺，也只代表流程韧性，必须记录为 AI 生成失败，不能计入多轮对白测试通过。

## 单一路径

```text
NpcDialogue（两个固定选择 + 一个自定义输入）
  → gameActionRequest（每次新 UUID）
  → POST /api/game/actions
  → requestParser（discriminated union + 字段白名单）
  → compositionRoot.performTurn
  → performTurn
  → GameRepository.applyState（一次规则 CAS）
  → PendingNarrativeJob
  → 后台生成协调器（gameId + jobId 去重）
```

请求合同：

```ts
type ActionRequest = {
  actionId: string;
  interaction:
    | { kind: "fixed_choice"; choiceToken: string }
    | { kind: "free_text"; text: string; targetNpcId: string };
  expectedRevision: number;
};
```

不存在独立 NPC dialogue route、独立对话 use case 或固定 `input_<npc>` action ID。

## 场景选择安全

- SceneSource 只提出 `ChoiceProposal`；审批器根据当前 NPC、当前 revision 和当前合法 Action 逐字段重建 `ApprovedChoice`。
- ready scene、choice registry 和候选事件池由一次 scene write-back CAS 持久化。
- 固定 token 只在其场景和 revision 有效；tampered、stale 或重复消费均零写入。
- 自定义输入也必须经过当前 NPC 在场、焦点匹配、文本长度和规则合法性检查。

## 主要文件

- `src/components/AdventureGameShell.tsx` — 两个固定选择和一个自定义输入。
- `src/components/gameActionRequest.ts` — 统一请求与浏览器 action ID。
- `src/app/api/game/actions/route.ts` — 唯一行动 HTTP adapter。
- `src/game/application/requestParser.ts` — 请求白名单与 discriminated union 解析。
- `src/game/application/performTurn.ts` — 统一回合编排。
- `src/game/application/actionConverter.ts` — token/free text 到 Action 的服务端转换。
- `src/game/application/gameSessionView.ts` — 焦点 NPC 对话 read model。
- `src/game/domain/npcSpeech.ts` — 直接台词归一化、通用确认句识别和无场景问候兜底。

## 主要验收

- `AdventureGameShell.test.tsx`：焦点 NPC 两个固定选择、一个自定义输入，同一请求 helper。
- `gameActionRequest.test.ts` 与 action route tests：两种输入同一端点、每次 UUID、字段白名单和错误映射。
- `performTurn.test.ts`：连续自定义输入拥有不同 action/turn ID、两次记忆、两次 pending、两次 CAS。
- `foundationJourney.test.ts` 与 `storyDivergenceJourney.test.ts`：固定选择和自定义输入可持续推进 15+ 回合并形成不同结局。

## 修改注意事项

- UI 不得制造 token、解析 token 或回退到业务 action key。
- 不能为“短问候”“闲聊”增加零写入快捷路径；成功输入就是正式玩家回合。
- 规则裁决和 NPC 知识边界不能交给 AI；AI 只负责 proposal 与表达。
- 场景生成、审批写回和 read model 投影都执行台词归一化，因此旧存档中已保存的“NPC 名称 + 动作 + 台词”包装不会继续出现在对话框。
- read model 会兼容旧交接存档：当已保存的 dialogue focus 与当前在场 talk 目标不一致时，丢弃过期的焦点选项并把旧 NPC 降为普通交谈入口；不要求玩家清档。
- 旧场景中可能持久化的 `smallTalk` 数据不再投影到客户端；非焦点 NPC 只显示真实的 `ask` 交谈入口，避免出现点击后只改本地显示、不产生回合的伪交互。
- 任何新输入形态必须先扩展 `Interaction` union，并继续通过 `/api/game/actions` 与 `performTurn`，不能新增并行入口。

## 历史说明

2026-08-09 之前的 dated Spec/Plan 曾描述并行版本路由、独立 dialogue use case 和旧 GameState 链；这些内容仅保留为历史决策记录，已被当前单一路径取代。
