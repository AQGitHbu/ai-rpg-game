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
- 玩家原文不写入长期记忆、事件账本或日志；长期记录只保存规则归一化的 dialogue act、topic summary 和 fact IDs。

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

## 主要验收

- `AdventureGameShell.test.tsx`：焦点 NPC 两个固定选择、一个自定义输入，同一请求 helper。
- `gameActionRequest.test.ts` 与 action route tests：两种输入同一端点、每次 UUID、字段白名单和错误映射。
- `performTurn.test.ts`：连续自定义输入拥有不同 action/turn ID、两次记忆、两次 pending、两次 CAS。
- `foundationJourney.test.ts` 与 `storyDivergenceJourney.test.ts`：固定选择和自定义输入可持续推进 15+ 回合并形成不同结局。

## 修改注意事项

- UI 不得制造 token、解析 token 或回退到业务 action key。
- 不能为“短问候”“闲聊”增加零写入快捷路径；成功输入就是正式玩家回合。
- 规则裁决和 NPC 知识边界不能交给 AI；AI 只负责 proposal 与表达。
- 任何新输入形态必须先扩展 `Interaction` union，并继续通过 `/api/game/actions` 与 `performTurn`，不能新增并行入口。

## 历史说明

2026-08-09 之前的 dated Spec/Plan 曾描述并行版本路由、独立 dialogue use case 和旧 GameState 链；这些内容仅保留为历史决策记录，已被当前单一路径取代。
