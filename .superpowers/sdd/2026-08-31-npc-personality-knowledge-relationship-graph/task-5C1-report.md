# Plan 3 Task 5C1 实施报告

## 结果

已在分支 `codex/npc-personality-knowledge-relationship-graph` 完成 Task 5C1，提交信息为：

`refactor(npc): the talk path submits one narrow-mutation batch`

实现严格限制在 brief 指定的 9 个源码/测试文件，另新增本报告；未修改其他文档或业务文件。

## RED 证据

先补测试并运行，确认旧实现按预期失败：

- `dialogueResolution.test.ts`：11 tests，10 failed。失败点覆盖 signal 缺失、旧 `relationshipDelta`/`npcAfter` 结构、首次见面数值加成、窄 mutation batch、emotion helper、hostile act 映射等。
- `resolveByType.test.ts`：29 tests，6 failed。失败点覆盖旧 talk 数值（support 为旧的 `+8`）、裸 ask 写入关系、replay 未拒绝、知识通道被重建、hostile signal 数值不符 brief。
- `entityMutation.test.ts`：124 tests，2 failed。失败点覆盖 `learnedFactIds` 与 fact topic 未通过 subject 自有 knowledge 校验。

RED 探针均通过 Edit/apply_patch 在 GREEN 阶段移除；没有使用 git checkout/restore/stash/clean 回退。

## 旧用例到新用例映射

| 旧行为/用例 | Task 5C1 新覆盖 |
| --- | --- |
| ask 直接按 tier 产生关系数值 | 裸 ask 无 signal、无关系写入；有真实 disclosure 才产生 `shared_fact` |
| 首次交谈固定 tier 加成 | 首次见面仅由 `set_npc_met` 表达，关系只接受 act signal |
| support/challenge/threaten 按数字 tier 结算 | 八类 act→signal 映射及 `outcome` trend 测试 |
| hostile 依赖负数关系差处理 | hostile threaten/deceive 保留失败 status，并验证 signal 与部分状态 mutation |
| utterance 作为关系摘要/写入来源 | utterance 仅进入 interaction payload，dialogue 保持纯函数 |
| resolver 内部直接同步 NPC projection | `resolveByType` 只应用 `dialogue.mutations`，再追加 event |
| 对话返回 npcAfter/relationshipDelta | 返回 `signal`、`interaction`、`mutations`；移除旧字段 |
| 事实引用只检查全局存在性 | 在任何写入前检查 subject 自有 `knowledge.entries`；同批 create_entities 可作为前置来源 |
| entityWorld facade 暴露 interaction formatter | 移除 facade re-export，formatter 保持 entityMutation 模块私有 |

## 行为变化

- 删除 dialogue tier modifier、首次见面关系 `+5` 与裸 ask 的 `+1`。
- 采用 R5-3a act→signal 映射：support `supported`、challenge `challenged`、threaten `threatened`、deceive `deceived`、offer `offered_help`、refuse `refused`、reassure `reassured`；ask 只有实际 disclosure 才是 `shared_fact`。
- `outcome` 从 signal trend 计算；无 signal 或 stable 为 neutral。
- talk 现在提交窄 mutation batch，顺序为 signal→interaction→必要时 emotion→必要时 met；`record_npc_interaction` 的 relationshipDelta/summary 继续由实体层根据实际状态计算和盖章。
- 同一 `actionId` replay 由实体 mutation 硬失败，且不产生任何写入。
- 对话 disclosure 不直接写玩家知识；`facts: []` 保留，并以注释标明 Task 7/8 传播链负责知识写入。
- `emotionForOutcome` 只在 dialogueResolution 保留一份，`updateNpcMemory` 复用它。
- fact learned/topic 引用必须属于 subject 自有 knowledge；quest/thread topic 继续由 Task 7 负责校验。

## 测试与门禁

- 定向新增/修改测试：3 files，164 tests passed。
- RPG 相关目录：18 files，310 tests passed。
- `npm run typecheck`：passed。
- `npx eslint src/game/gameplay/rpg`：passed。
- `npm run test:boundaries`：2 files，105 tests passed。
- `npm run check:standards`：passed。

全量 `npm test` 结果为 171 files、2225 tests，其中 2222 passed、3 failed。失败均在 brief 明确禁止修改的范围外：

1. `src/game/application/performTurn.test.ts` 的两个自定义 free-text 用例仍断言裸 ask 会产生 affinity 6 / relationshipDelta 6；这与 Task 5C1 要求的裸 ask 无 signal、无关系变化冲突。
2. `src/game/application/testing/narrativeGroundingJourney.test.ts` 的一个 hostile/trusted response 用例仍断言旧 hostile 文案；当前新窄 batch/关系语义下得到 trusted-style 文案。该测试和其应用层依赖不在允许修改范围内。

## Concerns

全量测试无法在不修改范围外测试、或违背 Task 5C1 裸 ask 与窄 batch要求的前提下全部通过。应用层旧断言应由后续兼容/整体验证任务单独更新；本任务未扩大范围处理。Task 5C2 的 give_item 旧链路未改动，符合本任务边界。
