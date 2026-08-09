# 运行时 AI 导演与场景表演

## 系统定位

运行时 AI 负责提出下一幕的结构化场景、对白和可选表达；规则系统负责审批候选、铸造玩家 token、裁决行动并写入状态。AI 不直接写存档，也不能决定任务、关系、知识、战斗或结局。

## 当前生产闭环

```text
成功玩家回合
  → PendingNarrativeJob
  → generatePendingScene
  → SceneGenerationContext（最小权限、当前合法候选）
  → SceneSource proposal（live 或 deterministic fallback）
  → approveAndWriteScene
  → ready scene + ApprovedChoice registry + candidate event pool
  → applySceneWriteBack（独立 CAS）
  → GameSessionView
```

## 已冻结约束

- SceneSource 只返回 proposal，不能返回可直接落库的 ready state。
- 对话场景绑定一个在场焦点 NPC，并提出两个语义不同的 TalkAction；其他场景从服务端给出的合法候选 ID 中选择两个不同 Action。
- live source 只能选择服务端候选 ID，不能发明任意 `actionKey`、实体 ID、事实 ID 或规则结果。
- 审批器逐字段重建 scene/event/choice；生成对象原引用不能直接持久化。
- 服务器根据 post-writeback revision 铸造 opaque `choiceToken`；客户端场景不含 `actionKey`、registry、候选 effect、隐藏事实或 AI diagnostics。
- ready scene、choice registry、candidate event pool 同一次 scene CAS 写回；行动消费时再次验证当前 scene、revision 与规则合法性。
- AI/fixture 失败使用确定性 fallback，fallback 也经过同一 proposal → approval → write-back 链。
- active battle、ending 或候选不足时不伪造普通场景选择。

## NPC 知识与输入隔离

- 导演只读取有界故事摘要、预算与合法候选；NPC 上下文只含自己的 profile、关系、已知/允许隐藏事实和最近结构化交互。
- 玩家自由文本只供当前回合意图解析；原文不进入长期记忆、事件账本、prompt replay 或日志。
- AI narration 与 NPC 台词不是规则事实。事实、任务、关系与结局只能来自已提交的结构化事件。

## 连续性与分化

- 每个成功玩家回合都排队下一幕，选择结果进入结构化状态和有界记忆，下一次生成读取这些已批准结果。
- 相同 seed 与相同输入/选择序列可确定性 replay；不同 seed 改变初始世界结构。
- 同 seed 下“支持/质疑”选择会改变 NPC affinity/emotion/history、候选事件和 ending ID，不只是改写叙事文案。

## 主要文件

- `src/game/application/sceneSource.ts` — proposal port。
- `src/game/application/sceneGenerationContext.ts` — 最小权限上下文与合法候选。
- `src/game/application/deterministicSceneSource.ts` — 离线 fallback proposal。
- `src/game/application/approveAndWriteScene.ts` — 场景与选择审批。
- `src/game/application/generatePendingScene.ts` — 生成编排与 write-back。
- `src/game/application/buildChoiceMap.ts` — 当前 registry/规则候选的 token 映射。
- `src/game/application/server/ai/liveSceneSource.ts` — live proposal source。
- `src/game/application/server/ai/sourceFactory.ts` — live/fallback 装配。

## 验收重点

- generated/fallback 场景各有两个 proposal、两个不同 token，scene JSON 无 `actionKey`。
- registry 的 `basedOnRevision` 等于 scene 写回后的 revision。
- tampered、stale、重复 token 零写入。
- live source 越权引用或失败不会绕过审批，也不会阻塞可完成的离线旅程。

## 历史说明

早期 dated 文档中的三角色 pipeline、版本化接口名和旧 scene adapter 只作历史记录。当前生产事实以本页列出的 neutral application/server 文件为准。
